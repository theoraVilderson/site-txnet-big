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
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"network-service/internal/config"
	"network-service/internal/db"
	"network-service/internal/httpapi"
	"network-service/internal/opener"
	"network-service/internal/publish"
	"network-service/internal/radius"
	"network-service/internal/register"
	"network-service/internal/shutdown"
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

	// Registration (ADR-0080): pending panels are tested on the registrar's
	// own tick and their verdict written back. It is the first loop this
	// process runs, because it needs nothing the collection loop still lacks
	// — a panel row, and a login read through tenant-service (F-027-ax).
	runCtx, stopLoops := context.WithCancel(ctx)
	defer stopLoops()
	vault := opener.Vault{BaseURL: cfg.TenantAPIBaseURL, ServiceToken: cfg.ServiceAuthToken}
	registrar := &register.Registrar{
		Store:  register.PostgresStore{DB: pool},
		Opener: opener.Opener{Logins: vault},
		Log:    log,
	}
	go func() { _ = registrar.Run(runCtx) }()

	// The RADIUS accounting receiver (F-027-af): the push half of
	// collection, and the one surface here reachable from outside. The
	// allowlist is read before the socket opens, so the first packet meets
	// the panels that exist rather than an empty list; a failure to bind is
	// a refusal to start, as a NAS would otherwise retransmit into nothing.
	nases := &radius.PanelDirectory{DB: pool, Secrets: vault, Log: log}
	if err := nases.Refresh(ctx); err != nil {
		log.Error("refusing to start", "error", err)
		os.Exit(1)
	}
	udp, err := net.ListenPacket("udp", cfg.RadiusAddr)
	if err != nil {
		log.Error("refusing to start", "error", fmt.Errorf("radius listener: %w", err))
		os.Exit(1)
	}
	sessions := radius.PostgresStore{DB: pool}
	receiver := &radius.Receiver{
		Directory: nases, Store: sessions, Sink: publish.Publisher{Transport: broker},
		Log: log, Concurrency: cfg.RadiusConcurrency,
	}
	go nases.Run(runCtx, cfg.RadiusRefresh)
	go radius.Sweeper{Store: sessions, StaleAfter: cfg.RadiusStaleAfter, Log: log}.Run(runCtx)
	go func() {
		log.Info("radius accounting listening", "addr", cfg.RadiusAddr)
		if err := receiver.Serve(runCtx, udp); err != nil {
			log.Error("radius receiver stopped", "error", err)
		}
	}()

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
	stopLoops()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()

	// The exit order is the decision here, and it is the extension first
	// (F-027-w). This process is the only thing that reads a panel's counters,
	// so from the moment it stops, no ceiling rises for anyone — and the
	// ceilings in force are sized at about two minutes of each user's own rate
	// (`contract.hot-loop.md`). Draining the HTTP server first would spend the
	// budget on a surface that answers nobody: `/health` is for the container
	// and the watchdog, and neither of them is a user mid-download.
	extendCeilings(shutdownCtx, log, ceilingExtender)

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "error", err)
	}
}

// ceilingExtender is nil until the panel source and the Postgres-backed
// `shutdown.Reserves` land — the same staging `collect.Loop` is in above.
// What the wiring buys today is the exit *order*, decided once and in one
// place, rather than at the moment a stalled deploy makes it urgent.
var ceilingExtender *shutdown.Extender

// extendCeilings raises every active ceiling to what the user's money still
// backs, before this process stops being able to raise any of them
// (ADR-0078).
//
// A failure is logged and never fatal. This runs on the way out: the bytes are
// billed, the cursors are where they should be, and the worst case is the
// state the system was in before this row existed — some users stalling until
// the collector is back. Exiting non-zero over it would turn that into a
// container the orchestrator restarts in a loop.
func extendCeilings(ctx context.Context, log *slog.Logger, extender *shutdown.Extender) {
	if extender == nil {
		return
	}
	if _, err := extender.Run(ctx); err != nil {
		log.Error("extending ceilings for shutdown failed", "error", err)
	}
}
