// Command gateway fronts the Rakazo API's /rpc surface. Slice 0 proxies every
// procedure to the TypeScript API unchanged.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/auth"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/config"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/gateway"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:3200", "address to listen on")
	upstream := flag.String("upstream", "http://127.0.0.1:3100", "TypeScript API base URL")
	routesPath := flag.String("routes", "", "routing table (JSON); empty proxies everything")
	buildIDFile := flag.String("build-id-file", "", "file holding the deployed web build id")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	target, err := url.Parse(*upstream)
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		logger.Error("invalid upstream URL", "upstream", *upstream)
		os.Exit(1)
	}
	if target.User != nil {
		logger.Error("upstream URL must not carry credentials", "upstream", target.Redacted())
		os.Exit(1)
	}

	store := routes.NewStore(*routesPath)
	if err := store.Load(); err != nil {
		logger.Error("load routes failed", "routes", *routesPath, "error", err)
		os.Exit(1)
	}

	wantsLocal := store.HasLocal()
	secretsReady := os.Getenv("DATABASE_URL") != "" && os.Getenv("BETTER_AUTH_SECRET") != ""
	var localServer *local.Server
	if secretsReady {
		server, closeDatabase, err := setupLocal(*buildIDFile, logger)
		if err != nil {
			if wantsLocal {
				logger.Error("cannot serve local procedures", "error", err)
				os.Exit(1)
			}
			logger.Warn("local procedures unavailable; serving proxy routes only", "error", err)
		} else {
			localServer = server
			defer closeDatabase()
			logger.Info("local procedures ready", "procedures", 3)
		}
	} else if wantsLocal {
		logger.Error("the routing table needs local procedures but DATABASE_URL/BETTER_AUTH_SECRET are unset")
		os.Exit(1)
	}

	handler := gateway.New(gateway.Options{Upstream: target, Routes: store, Logger: logger, Local: localServer})
	server := &http.Server{
		Addr:              *listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
		// No ReadTimeout/WriteTimeout: uploads and event streams are long-lived.
	}

	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for range hup {
			if err := store.Reload(); err != nil {
				logger.Error("routes reload failed; keeping the previous table", "error", err)
				continue
			}
			logger.Info("routes reloaded", "routes", store.Len())
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		signal := <-stop
		logger.Info("shutting down", "signal", signal.String())
		// Streams can outlive a deploy; give ordinary requests a moment, then cut.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			_ = server.Close()
		}
	}()

	logger.Info("gateway listening", "addr", *listen, "upstream", target.Redacted(), "routes", store.Len())
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func readBuildID(path string) string {
	if path == "" {
		return ""
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	value := strings.TrimSpace(string(body))
	if len(value) != 14 {
		return ""
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return ""
		}
	}
	return value
}

// setupLocal opens the database and builds the local procedure server. It is
// called whenever the deployment's secrets are present, even if every route is
// still proxy, so a SIGHUP cutover can use it without a restart.
func setupLocal(buildIDFile string, logger *slog.Logger) (*local.Server, func(), error) {
	deployment, err := config.Load()
	if err != nil {
		return nil, nil, err
	}
	startup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	database, err := db.Open(startup, deployment.DatabaseURL, "rakazo-api-go")
	if err != nil {
		return nil, nil, err
	}
	if err := database.StartupCheck(startup); err != nil {
		database.Close()
		return nil, nil, err
	}
	sessions := auth.New(database, auth.Config{
		Secret:          deployment.AuthSecret,
		AuthURL:         deployment.AuthURL,
		SignupAllowlist: deployment.SignupAllowlist,
		OIDCBypass:      deployment.OIDCBypass,
	})
	server := local.New(database, sessions, procedures.All(database), local.Config{
		BuildID:        readBuildID(buildIDFile),
		Minimums:       deployment.Minimums,
		MaxUploadBytes: deployment.MaxUploadBytes,
		WebOrigin:      deployment.WebOrigin,
		TrustedOrigins: deployment.TrustedOrigins,
		Logger:         logger,
	})
	return server, database.Close, nil
}
