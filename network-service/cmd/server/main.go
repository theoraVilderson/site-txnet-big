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

	"network-service/internal/collect"
	"network-service/internal/config"
	"network-service/internal/converge"
	"network-service/internal/db"
	"network-service/internal/hot"
	"network-service/internal/httpapi"
	"network-service/internal/leaseplan"
	"network-service/internal/opener"
	"network-service/internal/panelstate"
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
	// Registration (ADR-0080): pending panels are tested on the registrar's
	// own tick and their verdict written back, beside the collection loop
	// below, which reads only the panels it accepted (F-027-ax).
	runCtx, stopLoops := context.WithCancel(ctx)
	defer stopLoops()
	vault := opener.Vault{BaseURL: cfg.TenantAPIBaseURL, ServiceToken: cfg.ServiceAuthToken}
	registrar := &register.Registrar{
		Store:  register.PostgresStore{DB: pool},
		Opener: opener.Opener{Logins: vault},
		Log:    log,
	}
	go func() { _ = registrar.Run(runCtx) }()

	// The collection loop (F-027-bt), with the convergence pass inside it:
	// every accepted pull panel once a minute, one bulk read each, published
	// before its cursors move (invariant 18), then converged over one read of
	// its clients (`contract.budget.md`). Convergence rides the same turn
	// because the reset it has to act on is the one this pass just detected
	// (ADR-0072). Its drivers are opened through the same Opener the
	// registrar tested them with, so a panel is read by the driver it was
	// accepted through.
	cursors := &collect.PostgresCursors{DB: pool}
	health := &panelstate.Tracker{Writer: panelstate.PostgresWriter{DB: pool}, Log: log}
	panels := &collect.PostgresSource{
		DB: pool, Opener: opener.Opener{Logins: vault}, Cursors: cursors, States: health, Log: log,
	}
	turns := &collect.TurnLocks{}
	driftEvents := collect.PostgresDriftEvents{DB: pool}
	containment := &collect.Containment{Events: driftEvents}
	converger := &converge.Converger{
		Provisioning: &converge.Provisioning{
			Desired: converge.PostgresDesired{DB: pool}, Inbounds: converge.PostgresInbounds{DB: pool},
			Claims: converge.PostgresDesired{DB: pool}, Events: driftEvents, Log: log,
		},
		Ceilings: &converge.Ceilings{Allocations: converge.PostgresAllocations{DB: pool}, Counters: cursors, Log: log},
		Log:      log,
	}
	collector := &collect.Loop{
		Source:      panels,
		Sink:        publish.Publisher{Transport: broker},
		Cursors:     cursors,
		Ceilings:    converger,
		Health:      health,
		Rates:       collect.PostgresRates{DB: pool},
		Progress:    collect.PostgresProgress{DB: pool},
		Containment: containment,
		Turns:       turns,
		// The lease planner (ADR-0093): the only writer of a config's
		// ceiling since F-027-db; the convergence step carries it.
		Planner: &leaseplan.Planner{Store: leaseplan.PostgresStore{DB: pool}, Log: log, Blocks: publish.BlockRequests{Transport: broker}},
		Log:     log,
	}

	// A config whose desired state changed wakes its panel's convergence turn
	// at once (F-111-j): Postgres notifies on commit, and the waker folds a
	// purchase's rows into one turn per panel. The loop above stays the safety
	// net, so a wake lost while the listener reconnects is only the old delay.
	// A turn that wrote asks the same waker for the read that confirms it
	// (F-111-n), so a Grant activates seconds after its client is created.
	waker := &collect.Waker{Loop: collector, Panels: panels.Offered}
	converger.Confirm = waker.Confirm
	go func() { _ = collector.Run(runCtx) }()
	wakes := &collect.WakeListener{
		DatabaseURL:    cfg.DatabaseURL,
		ConnectTimeout: cfg.ConnectTimeout,
		Waker:          waker,
		Log:            log,
	}
	go wakes.Run(runCtx)

	// The hot loop (F-027-bu): the few configs near their ceiling, read on
	// their own interval through the bulk pass's panels, drivers, cursors,
	// sink, health, rates and containment — nothing downstream can tell the
	// two apart (`contract.hot-loop.md`). It shares the per-panel turn lock,
	// so the two never normalise one panel's counters at once, and it writes
	// to no panel: that is the convergence pass's, once a minute, because a
	// client list every two seconds is a denial of service on the panel.
	hotLoop := &hot.Loop{
		Source:      &hot.PostgresSource{DB: pool, Panels: panels, Cursors: cursors},
		Sink:        publish.Publisher{Transport: broker},
		Cursors:     cursors,
		Health:      health,
		Rates:       collect.PostgresRates{DB: pool},
		Containment: containment,
		Turns:       turns,
		Log:         log,
	}
	go func() { _ = hotLoop.Run(runCtx) }()

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
	extendCeilings(shutdownCtx, log, &shutdown.Extender{
		// The panels and drivers the bulk pass already opened: the exit
		// budget is seconds, and it is not spent on vault reads.
		Source:   collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return panels.Offered(), nil }),
		Reserves: shutdown.PostgresReserves{DB: pool},
		Counters: cursors,
		Health:   health,
		Turns:    turns,
		Log:      log,
	})

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "error", err)
	}
}

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
