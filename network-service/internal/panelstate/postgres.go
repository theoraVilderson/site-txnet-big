package panelstate

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// Execer is what PostgresWriter needs of the pool: db.Pool satisfies it.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresWriter is Writer over `panel.panelState` and `panel.blockedSince`
// (F-027-bt). Both move in one statement, which is how invariant 11 — a
// clock exactly when the panel is refusing us — holds under its CHECK.
type PostgresWriter struct {
	DB Execer
}

var _ Writer = PostgresWriter{}

const setStateSQL = `
UPDATE network.panel
   SET "panelState" = $2::network."PanelState", "blockedSince" = $3
 WHERE id = $1::uuid`

func (w PostgresWriter) SetState(ctx context.Context, panelID string, rec Record) error {
	var since any
	if rec.State == ThrottledOrBlocked && !rec.BlockedSince.IsZero() {
		since = rec.BlockedSince
	}
	if _, err := w.DB.Exec(ctx, setStateSQL, panelID, string(rec.State), since); err != nil {
		return fmt.Errorf("writing panel %s state: %w", panelID, err)
	}
	return nil
}
