// Command objectstore serves a private S3-compatible bucket from a local
// directory so a deployment gets object storage without any outside vendor.
// Point OBJECT_STORAGE_ENDPOINT at it with OBJECT_STORAGE_PATH_STYLE=true.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Anxiety471/Hivemind/apps/api-go/internal/objectserver"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:3300", "address to listen on; keep it on loopback or a private network")
	dir := flag.String("dir", "", "directory holding every object (required)")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(logger)
	if err := run(logger, *listen, *dir); err != nil {
		logger.Error("objectstore.failed", "error", err.Error())
		os.Exit(1)
	}
}

func run(logger *slog.Logger, listen, dir string) error {
	srv, err := objectserver.New(objectserver.Config{
		Dir:             dir,
		Bucket:          os.Getenv("OBJECT_STORAGE_BUCKET"),
		Region:          os.Getenv("OBJECT_STORAGE_REGION"),
		AccessKeyID:     os.Getenv("OBJECT_STORAGE_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("OBJECT_STORAGE_SECRET_ACCESS_KEY"),
		Logger:          logger,
	})
	if err != nil {
		return err
	}
	httpServer := &http.Server{
		Addr:              listen,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	logger.Info("objectstore.listening", "addr", listen)
	if err := httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
