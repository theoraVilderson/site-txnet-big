package reach

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// Execer is what PostgresHeartbeats needs of the pool: db.Pool satisfies it.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresHeartbeats is Heartbeats over `network.collector_heartbeat`, one
// row per instance.
type PostgresHeartbeats struct {
	DB Execer
}

var _ Heartbeats = PostgresHeartbeats{}

const beatSQL = `
INSERT INTO network.collector_heartbeat
       (instance, "startedAt", "passAt", "panelsAsked", "panelsFailed", egress, "egressSince")
VALUES ($1, $2, $3, $4, $5, $6::network."CollectorEgress", $7)
ON CONFLICT (instance) DO UPDATE
   SET "startedAt" = EXCLUDED."startedAt", "passAt" = EXCLUDED."passAt",
       "panelsAsked" = EXCLUDED."panelsAsked", "panelsFailed" = EXCLUDED."panelsFailed",
       egress = EXCLUDED.egress, "egressSince" = EXCLUDED."egressSince"`

func (h PostgresHeartbeats) Beat(ctx context.Context, b Beat) error {
	if _, err := h.DB.Exec(ctx, beatSQL, b.Instance, b.StartedAt, b.PassAt,
		b.Asked, b.Failed, string(b.Egress), b.EgressSince); err != nil {
		return fmt.Errorf("writing collector heartbeat: %w", err)
	}
	return nil
}
