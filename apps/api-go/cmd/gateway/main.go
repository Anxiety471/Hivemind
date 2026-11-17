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
	"syscall"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/gateway"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:3200", "address to listen on")
	upstream := flag.String("upstream", "http://127.0.0.1:3100", "TypeScript API base URL")
	routesPath := flag.String("routes", "", "routing table (JSON); empty proxies everything")
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

	handler := gateway.New(gateway.Options{Upstream: target, Routes: store, Logger: logger})
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
