package leaseplan

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/driver"
)

// DB is what the store needs of the pool: db.Pool satisfies it.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (db.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresStore is Store over `network.config` and `entitlement.grant`, the
// one read ADR-0094 allows outside `network.*` (`db.ForeignColumns`).
type PostgresStore struct {
	DB DB
}

var _ Store = PostgresStore{}

// loadSQL is every config of every active, metered-by-bytes Grant holding one
// of $1, retired ones included: their counters served bytes of the same bag.
//
// Quota is `purchasedBytes`, read. Used is summed in Go from each config's
// lifetime counter (`contract.lease.md`), which the pass that called us has
// already moved. A config is a replica only while it is meant to be on its
// panel. The counter a ceiling is measured on is the panel's last figure on a
// cumulative panel, and the lifetime sum where a read zeroes it.
const loadSQL = `
WITH touched AS (SELECT DISTINCT c."grantId" FROM network.config c WHERE c.id = ANY($1::uuid[]))
SELECT g.id::text, g."purchasedBytes", g."endsAt",
       c.id::text, c."panelId"::text,
       c.status <> 'retired' AND c."desiredRemote" = 'present',
       c."remoteId" IS NOT NULL,
       CASE WHEN p."counterSemantics" = 'cumulative'
            THEN coalesce(s."lastUpBytes" + s."lastDownBytes", 0)
            ELSE coalesce(s."lifetimeUpBytes" + s."lifetimeDownBytes", 0) END::bigint,
       coalesce(s."lifetimeUpBytes" + s."lifetimeDownBytes", 0)::bigint,
       coalesce(c."appliedCeilingBytes", 0)::bigint, c."desiredEnabled", c."allocatedCeilingBytes",
       p."driverType"::text,
       p."counterSemantics" = 'cumulative'
         AND coalesce((p.capabilities->'answers'->'per_client_data_limit'->>'supported')::boolean, false),
       p."panelState" = 'healthy',
       p."tickPeriodMs", p."tickPhaseMask",
       coalesce(p."lagMeanSec", 0), coalesce(p."lagVarianceSec2", 0), p."lagSamples"
  FROM touched t
  JOIN entitlement."grant" g ON g.id = t."grantId"
  JOIN network.config c ON c."grantId" = g.id
  JOIN network.panel p ON p.id = c."panelId"
  LEFT JOIN network.config_counter_state s ON s."configId" = c.id
 WHERE g.status = 'active' AND NOT g."trafficUnlimited"
 ORDER BY g.id, c.id`

func (s PostgresStore) Load(ctx context.Context, configIDs []string) (Snapshot, error) {
	rows, err := s.DB.Query(ctx, loadSQL, configIDs)
	if err != nil {
		return Snapshot{}, fmt.Errorf("reading the Grants of %d config(s): %w", len(configIDs), err)
	}
	defer rows.Close()
	snap := Snapshot{Panels: map[string]Panel{}}
	for rows.Next() {
		var (
			grantID, driverType string
			quota, lifetime     int64
			endsAt              *time.Time
			live                bool
			c                   Config
			pn                  Panel
			tickMs              *int32
			tickMask            *int64
		)
		if err := rows.Scan(&grantID, &quota, &endsAt, &c.ID, &c.PanelID, &live, &c.Exists, &c.Counter, &lifetime,
			&c.LimitSeen, &c.Enabled, &c.Allocated, &driverType, &pn.CanSetLimit, &pn.Healthy,
			&tickMs, &tickMask, &pn.Learned.LagMeanSec, &pn.Learned.LagVarianceSec2, &pn.Learned.LagSamples); err != nil {
			return Snapshot{}, fmt.Errorf("reading a Grant's config: %w", err)
		}
		if n := len(snap.Grants); n == 0 || snap.Grants[n-1].ID != grantID {
			g := Grant{ID: grantID, Quota: quota}
			if endsAt != nil {
				g.ExpiresAt = *endsAt
			}
			snap.Grants = append(snap.Grants, g)
		}
		g := &snap.Grants[len(snap.Grants)-1]
		g.Used += lifetime
		if !live {
			continue
		}
		g.Configs = append(g.Configs, c)
		pn.ID, pn.DriverType = c.PanelID, driver.DriverType(driverType)
		if tickMs != nil {
			pn.Learned.TickPeriod = time.Duration(*tickMs) * time.Millisecond
		}
		if tickMask != nil {
			mask := uint32(*tickMask) // CHECK panel_tick_phase_needs_period: 0..2^32-1
			pn.Learned.TickMask = &mask
		}
		snap.Panels[pn.ID] = pn
	}
	return snap, rows.Err()
}

// saveLearnedSQL writes the panel's learned state, and only when it differs
// from the row: the pass that learned nothing new writes nothing. No trigger
// reads these columns (`sub_panel_changed` is on `panelState` and `region`).
const saveLearnedSQL = `
UPDATE network.panel
   SET "tickPeriodMs" = $2, "tickPhaseMask" = $3,
       "lagMeanSec" = $4, "lagVarianceSec2" = $5, "lagSamples" = $6
 WHERE id = $1::uuid
   AND ("tickPeriodMs", "tickPhaseMask", "lagMeanSec", "lagVarianceSec2", "lagSamples")
       IS DISTINCT FROM ($2::int, $3::bigint, $4::float8, $5::float8, $6::int)`

// SaveLearned keeps what the planner learned of a panel (F-027-cz). The lag
// is null with no sample (CHECK `panel_lag_matches_samples`).
func (s PostgresStore) SaveLearned(ctx context.Context, panelID string, l Learned) error {
	var period *int32
	if l.TickPeriod > 0 {
		ms := int32(l.TickPeriod.Milliseconds())
		period = &ms
	}
	var mask *int64
	if l.TickMask != nil && period != nil {
		m := int64(*l.TickMask)
		mask = &m
	}
	var mean, variance *float64
	if l.LagSamples > 0 {
		mean, variance = &l.LagMeanSec, &l.LagVarianceSec2
	}
	if _, err := s.DB.Exec(ctx, saveLearnedSQL, panelID, period, mask, mean, variance, l.LagSamples); err != nil {
		return fmt.Errorf("saving panel %s's tick and lag: %w", panelID, err)
	}
	return nil
}
