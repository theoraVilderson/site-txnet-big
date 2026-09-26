package collect

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"network-service/internal/db"
)

// WakeChannel is the channel `network.notify_converge_config_changed` notifies
// on, with a panel id as the payload (migration
// `20260926000200_a_new_config_wakes_its_panel`). A trigger rather than a call
// in each writer, for ADR-0083's reason: the desired state is written by
// billing, by an admin's action and by hand, and a trigger hears all of them.
const WakeChannel = "network_converge"

// WakeListener holds one `LISTEN` connection and hands each notification to
// the Waker (F-111-j).
//
// A notification sent while it is reconnecting is lost, and that is accepted
// rather than repaired: the bulk pass converges every panel once an interval
// whatever this heard, so a lost wake is the delay this row removes, not a
// config left unplaced.
type WakeListener struct {
	DatabaseURL    string
	ConnectTimeout time.Duration
	Waker          *Waker
	Log            *slog.Logger
}

// Run listens until ctx ends, reconnecting with backoff.
func (w *WakeListener) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := w.listen(ctx)
		if ctx.Err() != nil {
			return
		}
		w.log().Warn("convergence wake listener stopped; new configs wait for the bulk pass until it is back",
			"error", err, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (w *WakeListener) listen(ctx context.Context) error {
	cfg, err := pgx.ParseConfig(w.DatabaseURL)
	if err != nil {
		return fmt.Errorf("parse database url: %w", err)
	}
	cfg.ConnectTimeout = w.ConnectTimeout
	cfg.RuntimeParams["application_name"] = db.ApplicationName + "-wake"
	cfg.RuntimeParams["default_transaction_read_only"] = "on"

	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "LISTEN "+WakeChannel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	w.log().Info("convergence wake listener live", "channel", WakeChannel)
	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait: %w", err)
		}
		w.Waker.Wake(ctx, n.Payload)
	}
}

func (w *WakeListener) log() *slog.Logger {
	if w.Log != nil {
		return w.Log
	}
	return slog.Default()
}
