// Command memory-roamer is a separate, low-priority memory worker. It reads one
// bot's durable memory at a time, asks the owner's live main model for a minimal
// consolidation, and writes it back through the Go memory package. It never
// serves HTTP and never touches chats, runs, or instructions.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/config"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/contentcrypto"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/db"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/memoryroam"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/modelcredentials"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/procedures/shared"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/secretstore"
)

func main() {
	var (
		dryRun   = flag.Bool("dry-run", false, "ask the model and report changes without writing memory")
		shared   = flag.Bool("shared", true, "roam each Space's shared memory once (default true; pass --shared=false to skip)")
		skills   = flag.Bool("skills", true, "create and upgrade each Space's skills once (default true; pass --skills=false to skip)")
		bots     = flag.String("bots", "", "comma-separated bot ids; empty visits every non-archived bot")
		force    = flag.Bool("force", false, "ignore the owner's switch and interval for this run")
		commands = flag.Bool("commands", false, "print the named commands a pass may run, then exit")
	)
	flag.Parse()
	if *commands {
		fmt.Println(memoryroam.CommandList())
		return
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	if err := run(logger, *dryRun, *shared, *skills, *bots, *force); err != nil {
		logger.Error("memory.roamer.failed", "error", err.Error())
		os.Exit(1)
	}
}

func run(logger *slog.Logger, dryRun, includeShared, includeSkills bool, bots string, force bool) error {
	deployment, err := config.Load()
	if err != nil {
		return err
	}
	maxTokens := envInt("MEMORY_ROAMER_MAX_TOKENS", 8192)
	timeout := time.Duration(envInt("MEMORY_ROAMER_TIMEOUT_MS", 180_000)) * time.Millisecond
	maxInput := envInt("MEMORY_ROAMER_MAX_INPUT_BYTES", 64*1024)
	delay := time.Duration(envInt("MEMORY_ROAMER_DELAY_MS", 500)) * time.Millisecond
	source := strings.ToLower(envDefault("MEMORY_ROAMER_MODEL_SOURCE", "main"))
	if source != "main" && source != "env" {
		return fmt.Errorf("MEMORY_ROAMER_MODEL_SOURCE must be main or env")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	database, err := db.Open(ctx, deployment.DatabaseURL, "rakazo-memory-roamer")
	if err != nil {
		return err
	}
	defer database.Close()
	if err := database.StartupCheck(ctx); err != nil {
		return err
	}
	provider, err := contentcrypto.NewLocalKeyProvider(deployment.MasterKeys)
	if err != nil {
		return err
	}
	store, err := contentcrypto.OpenPgSpaceKeyStore(ctx, database)
	if err != nil {
		return err
	}
	defer store.Close()
	ring := contentcrypto.NewKeyRing(provider, store, contentcrypto.KeyRingOptions{
		EncryptWrites: deployment.ContentEncryption,
	})
	if unreadable := ring.UnreadableMasterKeys(ctx); len(unreadable) > 0 {
		logger.Error("memory.roamer.master_keys_missing", "masterKeyIds", unreadable)
	}

	var envClient *memoryroam.Client
	if source == "env" {
		envClient, err = memoryroam.NewClient(memoryroam.ModelConfig{
			Style:     envDefault("MEMORY_ROAMER_API_STYLE", "openai"),
			BaseURL:   os.Getenv("MEMORY_ROAMER_BASE_URL"),
			Model:     os.Getenv("MEMORY_ROAMER_MODEL"),
			APIKey:    os.Getenv("MEMORY_ROAMER_API_KEY"),
			MaxTokens: maxTokens,
			Timeout:   timeout,
		})
		if err != nil {
			return err
		}
	}

	modelDeployment, err := modelDeployment(logger, database)
	if err != nil {
		return err
	}
	cache := map[string]modelClients{}
	clientsFor := func(ctx context.Context, bot memoryroam.Bot) ([]*memoryroam.Client, error) {
		if envClient != nil {
			return []*memoryroam.Client{envClient}, nil
		}
		key := bot.UserID + "\x00" + bot.SpaceID
		if cached, ok := cache[key]; ok {
			return cached.clients, cached.err
		}
		connections, err := modelcredentials.ResolveMainConnections(ctx, database, modelDeployment,
			db.Actor{UserID: bot.UserID, SpaceID: bot.SpaceID})
		var clients []*memoryroam.Client
		if err == nil {
			for _, connection := range connections {
				client, createErr := memoryroam.NewClient(memoryroam.ModelConfig{
					Style:     connection.Style,
					BaseURL:   connection.BaseURL,
					Model:     connection.ModelID,
					APIKey:    connection.APIKey,
					Headers:   connection.Headers,
					MaxTokens: maxTokens,
					Timeout:   timeout,
				})
				if createErr != nil {
					err = createErr
					continue
				}
				clients = append(clients, client)
			}
			if len(clients) == 0 && err == nil {
				err = fmt.Errorf("no callable main model connection")
			}
		}
		cache[key] = modelClients{clients: clients, err: err}
		return clients, err
	}

	report, err := memoryroam.Run(ctx, logger, database, ring, memoryroam.Config{
		ClientsFor:    clientsFor,
		MaxInputBytes: maxInput,
		Delay:         delay,
		DryRun:        dryRun,
		IncludeShared: includeShared,
		IncludeSkills: includeSkills,
		OnlyBots:      splitBots(bots),
		Force:         force || bots != "",
	})
	if err != nil {
		return err
	}
	level := slog.LevelDebug
	if dryRun || force || report.ModelCalls > 0 || report.Failures > 0 {
		level = slog.LevelInfo
	}
	logger.Log(ctx, level, "memory.roamer.pass", "dryRun", dryRun, "bots", report.Bots,
		"modelCalls", report.ModelCalls, "failures", report.Failures, "skipped", report.Skipped,
		"changes", report.Changes)
	if report.Failures > 0 {
		return fmt.Errorf("%d bot(s) failed", report.Failures)
	}
	return nil
}

type modelClients struct {
	clients []*memoryroam.Client
	err     error
}

// modelDeployment builds the credential vault the main-model resolver reads.
// It uses the same SECRET_STORE/ENCRYPTION_KEY pair the Go gateway uses.
func modelDeployment(logger *slog.Logger, database *db.DB) (shared.Deployment, error) {
	provider := strings.TrimSpace(os.Getenv("SECRET_STORE"))
	if provider != "" && provider != "encrypted" {
		return shared.Deployment{}, fmt.Errorf(
			"SECRET_STORE %q is not supported by the Go credential store: only \"encrypted\"", provider)
	}
	key, err := secretstore.ResolveEncryptionKey(os.Getenv)
	if err != nil {
		return shared.Deployment{}, err
	}
	store, err := secretstore.NewStore(key)
	if err != nil {
		return shared.Deployment{}, err
	}
	writer := secretstore.NewWriter(store, secretstore.NewNotifier(
		&secretstore.PGPublisher{DB: database, Logger: logger}))
	return shared.Deployment{Vault: &shared.SecretVault{
		Writer:      writer,
		Persistence: secretstore.NewPersistence(database, writer),
	}}, nil
}

func envDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		slog.Warn("memory.roamer.bad_env", "name", name, "value", raw)
		return fallback
	}
	return value
}

func splitBots(value string) []string {
	var ids []string
	for _, part := range strings.Split(value, ",") {
		if id := strings.TrimSpace(part); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}
