// Command server is `sub-service` (ADR-0082): `GET /sub/{token}` on a
// tenant's subscription domain, and nothing else.
//
// It is read-only against Postgres and never contacts a panel. Prisma owns the
// schema, so it checks at boot that it connected as the cross-tenant role, in
// a read-only session, against the columns it reads — and refuses to start
// otherwise.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"sub-service/internal/config"
	"sub-service/internal/db"
	"sub-service/internal/httpapi"
	"sub-service/internal/sub"
	"sub-service/pkg/logger"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}

	log := logger.New(os.Getenv("LOG_LEVEL"))

	ctx := context.Background()
	pool, err := db.New(ctx, db.Options{
		DatabaseURL:    cfg.DatabaseURL,
		MaxConns:       cfg.PoolMaxConns,
		MinConns:       cfg.PoolMinConns,
		MaxConnLife:    cfg.PoolMaxConnLife,
		MaxConnIdle:    cfg.PoolMaxConnIdle,
		ConnectTimeout: cfg.ConnectTimeout,
	})
	if err != nil {
		log.Error("database unavailable", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	assertCtx, cancelAssert := context.WithTimeout(ctx, cfg.BootAssertTimeout)
	err = db.AssertReady(assertCtx, pool)
	cancelAssert()
	if err != nil {
		log.Error("refusing to start", "error", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", httpapi.New(pool, log).Health)
	sub.New(db.Store{DB: pool}, log).Register(mux)

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}

	go func() {
		log.Info("sub-service listening", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "error", err)
	}
}
