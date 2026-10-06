package panelstate

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// Execer is what PostgresWriter needs of the pool: db.Pool satisfies it.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresWriter is Writer over `panel.panelState` and `panel.blockedSince`
// (F-027-bt), and since ADR-0122 `panelStateCause` and `panelStateSince`.
// They move in one statement, which is how invariant 11 — a clock exactly
// when the panel is refusing us — and `panel_state_cause_needs_trouble`
// hold under their CHECKs.
type PostgresWriter struct {
	DB Execer
}

var _ Writer = PostgresWriter{}

const setStateSQL = `
UPDATE network.panel
   SET "panelState" = $2::network."PanelState", "blockedSince" = $3,
       "panelStateCause" = $4::network."PanelFaultCause", "panelStateSince" = $5
 WHERE id = $1::uuid`

func (w PostgresWriter) SetState(ctx context.Context, panelID string, rec Record) error {
	var blocked, cause, since any
	if rec.State == ThrottledOrBlocked && !rec.BlockedSince.IsZero() {
		blocked = rec.BlockedSince
	}
	if rec.State != Healthy && rec.Cause != "" {
		cause = string(rec.Cause)
	}
	if !rec.Since.IsZero() {
		since = rec.Since
	}
	if _, err := w.DB.Exec(ctx, setStateSQL, panelID, string(rec.State), blocked, cause, since); err != nil {
		return fmt.Errorf("writing panel %s state: %w", panelID, err)
	}
	return nil
}

// checkedSQL never moves a stamp backwards: a polled turn and the bulk pass
// can finish out of order.
const checkedSQL = `
UPDATE network.panel
   SET "panelCheckedAt" = GREATEST(coalesce("panelCheckedAt", $2), $2),
       "lastHealthyAt"  = CASE WHEN $3 THEN GREATEST(coalesce("lastHealthyAt", $2), $2) ELSE "lastHealthyAt" END
 WHERE id = $1::uuid`

func (w PostgresWriter) Checked(ctx context.Context, panelID string, at time.Time, healthy bool) error {
	if _, err := w.DB.Exec(ctx, checkedSQL, panelID, at, healthy); err != nil {
		return fmt.Errorf("stamping panel %s check: %w", panelID, err)
	}
	return nil
}
