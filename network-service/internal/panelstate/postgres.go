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

// StateChangedEvent is the outbox type every state write is announced under
// (F-027-el, ADR-0122): worker-service pushes it on the owner's `tenant:`
// channel and tells the owner what to fix. Declared in
// contracts/realtime/events.json. A write happens only on a confirmed change
// of state or cause (`Verdict.Changed`), and never for a frozen turn, so each
// event is one an owner should hear about.
const StateChangedEvent = "network.panel.state_changed"

// setStateSQL writes the state and its event in one statement, so they
// commit or fail together (ADR-0021). `was` reads the row before the update —
// every CTE sees the same snapshot — so the event carries what it changed
// from. The owner is the panel's tenant, or the platform_owner's for a
// platform panel (invariant 9), named here as `network.panel.tested` names it.
const setStateSQL = `
WITH was AS (
  SELECT "panelState"::text AS state FROM network.panel WHERE id = $1::uuid
), changed AS (
  UPDATE network.panel
     SET "panelState" = $2::network."PanelState", "blockedSince" = $3,
         "panelStateCause" = $4::network."PanelFaultCause", "panelStateSince" = $5
   WHERE id = $1::uuid
  RETURNING id, name, "tenantId", "panelState", "panelStateCause", "panelStateSince"
)
INSERT INTO automation.outbox_event (id, aggregate, "aggregateId", type, payload)
SELECT gen_random_uuid(), 'network.panel', c.id::text, $6::text,
       jsonb_build_object(
         'panelId', c.id::text,
         'panelName', c.name,
         'tenantId', o.id::text,
         'ownerUserId', o."ownerUserId"::text,
         'panelState', c."panelState"::text,
         'previousState', w.state,
         'cause', c."panelStateCause"::text,
         'since', c."panelStateSince")
  FROM changed c
  CROSS JOIN was w
  LEFT JOIN LATERAL (
    SELECT o.id, o."ownerUserId" FROM tenant.tenant o
     WHERE o.id = c."tenantId"
        OR (c."tenantId" IS NULL AND o."tenantType" = 'platform_owner')
     ORDER BY o."createdAt", o.id LIMIT 1) o ON true`

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
	if _, err := w.DB.Exec(ctx, setStateSQL, panelID, string(rec.State), blocked, cause, since, StateChangedEvent); err != nil {
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
