// Command server is the network plane's collector process (ADR-0071).
//
// It owns `network.*` rows and nothing else: Prisma owns the schema and this
// service generates no migrations, so it verifies at boot that the columns it
// depends on exist and refuses to start if they do not. It is deliberately
// unreachable from the gateway — it connects as the cross-tenant role and
// never answers a user request.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"network-service/internal/config"
	"network-service/internal/db"
	"network-service/internal/httpapi"
	"network-service/internal/publish"
	"network-service/pkg/logger"
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

	// The boot gate. A collector running against a schema it was not written
	// against reports numbers rather than errors, and a wrong number is only
	// found afterwards — so this is a refusal, not a warning.
	assertCtx, cancelAssert := context.WithTimeout(ctx, cfg.BootAssertTimeout)
	err = db.AssertReady(assertCtx, pool)
	cancelAssert()
	if err != nil {
		log.Error("refusing to start", "error", err)
		os.Exit(1)
	}

	// The second boot gate, and the same argument as the first: a collector
	// that cannot publish a pass cannot move a cursor, so it would re-read the
	// same bytes for ever while looking healthy (invariant 18, F-027-m). The
	// exchange is asserted here, before anything is collected.
	broker, err := publish.DialAMQP(publish.AMQPOptions{
		URL:            cfg.BrokerURL,
		Exchange:       cfg.BrokerExchange,
		ConfirmTimeout: cfg.BrokerPublishTimeout,
	})
	if err != nil {
		log.Error("refusing to start", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := broker.Close(); err != nil {
			log.Error("broker close failed", "error", err)
		}
	}()
	// `publish.Publisher{Transport: broker}` is the collection loop's sink.
	// The loop is not started here yet: it needs its panels read off
	// `network.panel` and its cursors in Postgres, and each is a row of its
	// own. What this gate buys today is that the exchange and the credentials
	// are wrong at boot, in the log, rather than at 03:00 in a pass.

	mux := http.NewServeMux()
	mux.HandleFunc("/health", httpapi.New(pool, log).Health)

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}

	go func() {
		log.Info("network-service listening", "port", cfg.Port, "schema", db.Schema)
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
