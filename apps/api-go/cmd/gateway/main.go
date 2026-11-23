// Command gateway fronts the Rakazo API's /rpc surface. Slice 0 proxies every
// procedure to the TypeScript API unchanged.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
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
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/drive"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/effects"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/events"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/filestore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/gateway"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/local"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/routes"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/taskdetect"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/taskqueue"
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
	// A vault procedure may be routed even when no other local procedure is; its store key is
	// read only for that, so a proxy-only table still starts without ENCRYPTION_KEY.
	wantsVault := false
	for _, name := range procedures.VaultProcedures() {
		if mode := store.ProcedureMode(name); mode == routes.Shadow || mode == routes.Go {
			wantsVault = true
			break
		}
	}
	secretsReady := os.Getenv("DATABASE_URL") != "" && os.Getenv("BETTER_AUTH_SECRET") != ""
	bgCtx, cancelBg := context.WithCancel(context.Background())
	defer cancelBg()
	var localServer *local.Server
	var driveHandler http.Handler
	var taskDetector *taskdetect.Service
	var taskQueue *taskqueue.Service
	if secretsReady {
		server, dHandler, detector, queueSvc, closeDatabase, err := setupLocal(*buildIDFile, wantsVault, logger)
		if err != nil {
			if wantsLocal {
				logger.Error("cannot serve local procedures", "error", err)
				os.Exit(1)
			}
			logger.Warn("local procedures unavailable; serving proxy routes only", "error", err)
		} else {
			localServer = server
			driveHandler = dHandler
			taskDetector = detector
			taskQueue = queueSvc
			if taskQueue != nil {
				taskQueue.Start(bgCtx)
			}
			defer closeDatabase()
			logger.Info("local procedures ready", "procedures", server.Count())
		}
	} else if wantsLocal {
		logger.Error("the routing table needs local procedures but DATABASE_URL/BETTER_AUTH_SECRET are unset")
		os.Exit(1)
	}

	handler := gateway.New(gateway.Options{
		Upstream:     target,
		Routes:       store,
		Logger:       logger,
		Local:        localServer,
		TaskDetector: taskDetector,
		TaskQueue:    taskQueue,
		Drive:        driveHandler,
	})
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
	drained := make(chan struct{})
	go func() {
		defer close(drained)
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
	// ListenAndServe returns as soon as shutdown starts. Wait for in-flight requests to finish
	// (a write may be mid-transaction) and for background signals to go out before the pool closes.
	<-drained
	cancelBg()
	if taskQueue != nil {
		taskQueue.Wait()
	}
	if localServer != nil {
		localServer.Wait()
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
func setupLocal(buildIDFile string, wantsVault bool, logger *slog.Logger) (*local.Server, http.Handler, *taskdetect.Service, *taskqueue.Service, func(), error) {
	deployment, err := config.Load()
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	startup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	database, err := db.Open(startup, deployment.DatabaseURL, "rakazo-api-go")
	if err != nil {
		return nil, nil, nil, nil, nil, err
	}
	if err := database.StartupCheck(startup); err != nil {
		database.Close()
		return nil, nil, nil, nil, nil, err
	}
	sessions := auth.New(database, auth.Config{
		Secret:          deployment.AuthSecret,
		AuthURL:         deployment.AuthURL,
		SignupAllowlist: deployment.SignupAllowlist,
		OIDCBypass:      deployment.OIDCBypass,
		CookieDomain:    deployment.CookieDomain,
	})
	ring, closeRing, err := contentRing(startup, database, deployment, logger)
	if err != nil {
		database.Close()
		return nil, nil, nil, nil, nil, err
	}
	blobStore, err := filestore.NewDeploymentStore(deployment, ring)
	if err != nil {
		closeRing()
		database.Close()
		return nil, nil, nil, nil, nil, err
	}
	// The credential store is built only when a vault procedure is routed: reading its key is a
	// startup failure otherwise, and a proxy-only table must start without it (Lane F).
	var vault *shared.SecretVault
	if wantsVault {
		builtVault, err := buildSecretVault(database, logger)
		if err != nil {
			closeRing()
			database.Close()
			return nil, nil, nil, nil, nil, err
		}
		vault = builtVault
	}
	organizerVault := vault
	if organizerVault == nil {
		if optionalVault, optErr := buildSecretVault(database, logger); optErr != nil {
			logger.Debug("drive upload organizer vault unavailable", "error", optErr)
		} else {
			organizerVault = optionalVault
		}
	}
	// One runner per process: the middleware publishes its own roster/Space signals through
	// it, and the procedures publish thread cursors, organization and board changes through
	// the same notifier, so Wait() covers every signal either side started.
	effectsRunner := effects.NewRunner(database, logger)
	driveSvc := drive.NewService(
		database,
		blobStore,
		effectsRunner.Signals(),
		deployment.MaxFileUploadBytes,
		deployment.MaxUploadBytes,
		logger,
	)
	driveSvc.SetOrganizer(drive.NewOrganizer(
		driveSvc,
		database,
		blobStore,
		newMainModelResolver(database, shared.Deployment{Vault: organizerVault}),
		logger,
	))
	driveHTTP := drive.NewHTTPHandler(driveSvc, sessions, drive.HTTPConfig{
		WebOrigin:      deployment.WebOrigin,
		TrustedOrigins: deployment.TrustedOrigins,
		ClientIP:       deployment.ClientIP,
		ClientIPHeader: deployment.ClientIPHeader,
		Logger:         logger,
	})
	// One listener on rakazo_events serves every event stream this process answers.
	realtime := events.NewFanout(database.Pool.Config().ConnConfig, logger)
	// The queue is built before the procedures so a ticket move or comment can wake workers on it.
	var queueStore taskqueue.QueueStore
	if deployment.RedisURL != "" {
		redisStore, redisErr := taskqueue.OpenRedis(startup, deployment.RedisURL, taskqueue.DefaultKeyPrefix)
		if redisErr != nil {
			logger.Warn("redis task queue unavailable; falling back to in-memory queue", "error", redisErr)
			queueStore = taskqueue.NewMemoryStore(nil)
		} else {
			queueStore = redisStore
			logger.Info("redis task queue connected")
		}
	} else {
		queueStore = taskqueue.NewMemoryStore(nil)
	}
	queueSvc := taskqueue.New(taskqueue.Config{
		Store:        queueStore,
		DB:           database,
		Signals:      effectsRunner.Signals(),
		BoardLab:     deployment.BoardLab,
		Logger:       logger,
		MaxAttempts:  deployment.TaskQueueMaxAttempts,
		BumpInterval: deployment.TaskBumpInterval,
		BumpIdle:     deployment.TaskBumpIdle,
		BumpCooldown: deployment.TaskBumpCooldown,
	})
	server := local.New(database, sessions, procedures.All(database, shared.Deployment{
		WebOrigin:            strings.TrimRight(deployment.WebOrigin, "/"),
		EmailDelivery:        deployment.EmailDelivery,
		InboundEmailDomain:   deployment.InboundEmailDomain,
		MaxComputersPerUser:  deployment.MaxComputersPerUser,
		Content:              ring,
		Events:               &events.PGPublisher{Pool: database.Pool},
		Realtime:             realtime,
		Signals:              effectsRunner.Signals(),
		BoardLab:             deployment.BoardLab,
		PhoneCallsEnabled:    deployment.PhoneCallsEnabled,
		PhoneCallRingSeconds: deployment.PhoneCallRingSeconds,
		Audit:                effectsRunner.Recorder(),
		Waker:                queueSvc,
		Drive:                driveSvc,
		Vault:                vault,
		DefaultModel: deploymentModel(deployment.DefaultModelProvider, deployment.DefaultModel,
			deployment.DefaultModelConfigured),
		ApprovalModel: &shared.ModelSelection{
			Provider: deployment.ApprovalModelProvider,
			ModelID:  deployment.ApprovalModel,
		},
		ApprovalModelConfigured: deployment.ApprovalModelConfigured,
		Me: shared.MeConfig{
			DeploymentProvider:                    deployment.DefaultModelProvider,
			DeploymentModel:                       deployment.DefaultModel,
			DeploymentModelConfigured:             deployment.DefaultModelConfigured,
			DeploymentModelHostCredentials:        deployment.DeploymentModelHostCredentials,
			DeploymentModelHostCredentialsUnknown: deployment.DeploymentModelHostCredentialsUnknown,
			DeploymentLabs:                        deploymentLabs(deployment.BoardLab),
			NavLinks:                              navLinks(deployment.MeEnv.NavLinks),
			NavLinksUnknown:                       deployment.MeEnv.NavLinksUnknown,
			DriveURL:                              deployment.MeEnv.DriveURL,
			AppURL:                                driveAppURL(deployment.MeEnv.DriveURL, deployment.WebOrigin),
			ComputerSettingsEnabled:               deployment.MeEnv.ComputerSettingsEnabled,
			DesktopHostChoiceEnabled:              deployment.MeEnv.DesktopHostChoiceEnabled,
			SandboxProvider:                       deployment.MeEnv.SandboxProvider,
			AgentRuntime:                          deployment.MeEnv.AgentRuntime,
			McpStdioEnabled:                       deployment.MeEnv.McpStdioEnabled && len(deployment.MeEnv.McpStdioAllowedCommands) > 0,
			AdminEmails:                           deployment.MeEnv.AdminEmails,
			MaxUploadBytes:                        deployment.MaxUploadBytes,
			MaxAttachmentsPerMessage:              deployment.MeEnv.MaxAttachmentsPerMessage,
			AttachmentsUnknown:                    deployment.MeEnv.AttachmentsUnknown,
			BillingConfigured:                     deployment.MeEnv.BillingConfigured,
			PaymentWalletProvider:                 deployment.MeEnv.PaymentWalletProvider,
		},
	}), local.Config{
		BuildID:        readBuildID(buildIDFile),
		Minimums:       deployment.Minimums,
		MaxUploadBytes: deployment.MaxUploadBytes,
		ClientIP:       deployment.ClientIP,
		ClientIPHeader: deployment.ClientIPHeader,
		WebOrigin:      deployment.WebOrigin,
		TrustedOrigins: deployment.TrustedOrigins,
		Logger:         logger,
		Effects:        effectsRunner,
	})
	detector := &taskdetect.Service{
		DB:       database,
		BoardLab: deployment.BoardLab,
		Content:  ring,
		Signals:  effectsRunner.Signals(),
		Waker:    queueSvc,
		Logger:   logger,
	}
	driveRoutes := http.NewServeMux()
	driveRoutes.Handle("/api/v1/files", driveHTTP)
	driveRoutes.Handle("/api/v1/files/", driveHTTP)
	if deployment.MeEnv.DriveURL != "" {
		driveRoutes.Handle(auth.DriveOpenPath, sessions.DriveOpen(deployment.MeEnv.DriveURL))
	}
	return server, driveRoutes, detector, queueSvc, func() {
		driveSvc.Wait()
		_ = queueSvc.Close()
		realtime.Close()
		closeRing()
		database.Close()
	}, nil
}

func buildSecretVault(database *db.DB, logger *slog.Logger) (*shared.SecretVault, error) {
	provider := strings.TrimSpace(os.Getenv("SECRET_STORE"))
	if provider != "" && provider != "encrypted" {
		return nil, fmt.Errorf(
			"SECRET_STORE %q is not supported by the Go credential store: only \"encrypted\"", provider)
	}
	key, err := secretstore.ResolveEncryptionKey(os.Getenv)
	if err != nil {
		return nil, err
	}
	store, err := secretstore.NewStore(key)
	if err != nil {
		return nil, err
	}
	writer := secretstore.NewWriter(store, secretstore.NewNotifier(
		&secretstore.PGPublisher{DB: database, Logger: logger}))
	return &shared.SecretVault{
		Writer:      writer,
		Persistence: secretstore.NewPersistence(database, writer),
	}, nil
}

// contentRing builds the Space key ring. A provider this build cannot use, a missing master
// key or a stored key no master key unwraps stops startup: serving encrypted procedures with
// a ring that cannot open rows would turn every memory read into a 500, silently (apps/api/src/
// app.ts:342-346 logs the last case at startup for the same reason).
func contentRing(ctx context.Context, database *db.DB, deployment config.Config, logger *slog.Logger) (*contentcrypto.KeyRing, func(), error) {
	provider, err := contentcrypto.NewLocalKeyProvider(deployment.MasterKeys)
	if err != nil {
		return nil, nil, err
	}
	store, err := contentcrypto.OpenPgSpaceKeyStore(ctx, database)
	if err != nil {
		return nil, nil, err
	}
	ring := contentcrypto.NewKeyRing(provider, store, contentcrypto.KeyRingOptions{
		EncryptWrites: deployment.ContentEncryption,
	})
	if unreadable := ring.UnreadableMasterKeys(ctx); len(unreadable) > 0 {
		logger.Error("stored space keys need master keys that are not configured", "masterKeyIds", unreadable)
	}
	return ring, store.Close, nil
}

// deploymentModel is the deployment's own main model when it has a usable key or host
// credentials; nil means resolveDeploymentModel reports it unconfigured, and the deploy
// default then names nothing.
func deploymentModel(provider, model string, configured bool) *shared.ModelSelection {
	if !configured {
		return nil
	}
	return &shared.ModelSelection{Provider: provider, ModelID: model}
}

// deploymentLabs is deploymentLabsFromEnv: LAB_FEATURES this deployment turns on for every
// account. Only "board" exists (packages/contracts/src/labs.ts:4).
func deploymentLabs(board bool) []string {
	if board {
		return []string{"board"}
	}
	return []string{}
}

// navLinks converts the parsed RAKAZO_NAV_LINKS to the wire shape `me` returns.
func navLinks(links []config.NavLink) []shared.NavLink {
	converted := make([]shared.NavLink, len(links))
	for index, link := range links {
		converted[index] = shared.NavLink{
			ID: link.ID, Label: link.Label, Path: link.Path, Trusted: link.Trusted,
		}
	}
	return converted
}

// driveAppURL is the web origin the Drive app links back to; it is sent only where a Drive app runs.
func driveAppURL(driveURL, webOrigin string) string {
	if driveURL == "" {
		return ""
	}
	return strings.TrimRight(webOrigin, "/")
}
