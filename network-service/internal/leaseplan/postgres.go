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

// PostgresStore is Store over `network.config`, `entitlement.grant` and the
// owner's `billing.wallet` — the reads ADR-0094 allows outside `network.*`
// (`db.ForeignColumns`).
type PostgresStore struct {
	DB DB
}

var _ Store = PostgresStore{}

// loadSQL is every config of every Grant holding one of $2, or holding a
// config on panel $1 that no plan has given a ceiling yet (F-027-db: its
// first share is the planner's). Retired configs are included: their
// counters served bytes of the same bag. A Grant is planned while it is
// `active`, or `pending` — a group's Grant activates on what its panels
// confirm, so its configs need a ceiling first — and only if it sold a limit.
//
// Quota is `purchasedBytes`, read; on a metered Grant with a locked rate the
// wallet's reserve is added to it (F-027-dc): what the owner's balance still
// buys at that rate (BytesAffordable), computed from the columns' decimal
// text. A user with no wallet row has a reserve of nothing. Used is summed in Go from each config's
// lifetime counter (`contract.lease.md`), which the pass that called us has
// already moved. A config is a replica while it can carry traffic — the
// split's own rule (`contract.ceiling.md` "Who is in the split"). The counter
// a ceiling is measured on is the panel's last figure on a cumulative panel,
// and the lifetime sum where a read zeroes it.
const loadSQL = `
WITH touched AS (
  SELECT DISTINCT c."grantId" FROM network.config c
   WHERE c.id = ANY($2::uuid[])
      OR (c."panelId" = $1::uuid AND c."allocatedCeilingBytes" IS NULL AND NOT c."trafficUnlimited"
          AND c.status = 'active' AND c."desiredEnabled" AND c."desiredRemote" = 'present'))
SELECT g.id::text, g."purchasedBytes", g."endsAt",
       g."billingMode" = 'metered' AND g."meteredRate" IS NOT NULL,
       coalesce(g."meteredRate"::text, ''), coalesce(w."cachedBalance"::text, ''),
       c.id::text, c."panelId"::text,
       c.status = 'active' AND c."desiredEnabled" AND c."desiredRemote" = 'present',
       c."remoteId" IS NOT NULL,
       CASE WHEN p."counterSemantics" = 'cumulative'
            THEN coalesce(s."lastUpBytes" + s."lastDownBytes", 0)
            ELSE coalesce(s."lifetimeUpBytes" + s."lifetimeDownBytes", 0) END::bigint,
       coalesce(s."lifetimeUpBytes" + s."lifetimeDownBytes", 0)::bigint,
       coalesce(c."appliedCeilingBytes", 0)::bigint, c."desiredEnabled",
       c."allocatedCeilingBytes", c."limitPeakBytes", c."writePending",
       p."driverType"::text,
       p."counterSemantics" = 'cumulative'
         AND coalesce((p.capabilities->'answers'->'per_client_data_limit'->>'supported')::boolean, false),
       p."panelState" = 'healthy',
       p."tickPeriodMs", p."tickPhaseMask",
       coalesce(p."lagMeanSec", 0), coalesce(p."lagVarianceSec2", 0), p."lagSamples"
  FROM touched t
  JOIN entitlement."grant" g ON g.id = t."grantId"
  LEFT JOIN billing.wallet w ON w."ownerUserId" = g."userId"
  JOIN network.config c ON c."grantId" = g.id
  JOIN network.panel p ON p.id = c."panelId"
  LEFT JOIN network.config_counter_state s ON s."configId" = c.id
 WHERE g.status IN ('active', 'pending') AND NOT g."trafficUnlimited"
 ORDER BY g.id, c.id`

func (s PostgresStore) Load(ctx context.Context, panelID string, configIDs []string) (Snapshot, error) {
	rows, err := s.DB.Query(ctx, loadSQL, panelID, configIDs)
	if err != nil {
		return Snapshot{}, fmt.Errorf("reading the Grants of %d config(s) on panel %s: %w", len(configIDs), panelID, err)
	}
	defer rows.Close()
	snap := Snapshot{Panels: map[string]Panel{}}
	for rows.Next() {
		var (
			grantID, driverType string
			metered             bool
			rate, balance       string
			quota, lifetime     int64
			applied             int64
			endsAt              *time.Time
			live                bool
			c                   Config
			pn                  Panel
			tickMs              *int32
			tickMask            *int64
		)
		if err := rows.Scan(&grantID, &quota, &endsAt, &metered, &rate, &balance, &c.ID, &c.PanelID, &live, &c.Exists, &c.Counter, &lifetime,
			&applied, &c.Enabled, &c.Allocated, &c.Peak, &c.Pending, &driverType, &pn.CanSetLimit, &pn.Healthy,
			&tickMs, &tickMask, &pn.Learned.LagMeanSec, &pn.Learned.LagVarianceSec2, &pn.Learned.LagSamples); err != nil {
			return Snapshot{}, fmt.Errorf("reading a Grant's config: %w", err)
		}
		if n := len(snap.Grants); n == 0 || snap.Grants[n-1].ID != grantID {
			g := Grant{ID: grantID, Quota: quota, Purchased: quota, Metered: metered}
			if metered {
				g.Quota += BytesAffordable(rate, balance)
			}
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
		c.Offset = max(lifetime-c.Counter, 0)
		if applied > 0 {
			c.LimitSeen = max(applied-c.Offset, 0)
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

// saveLeasesSQL writes each lease in one statement, its rows locked in id
// order as every other writer of `network.config` does (invariant 54). The
// shutdown figure is the share itself: since F-027-dc the reserve is part of
// Quota, so the share already holds what the wallet backs, and CHECK
// `config_wallet_backed_ceiling_extends` holds it at least the share. A lease with no allocation leaves both as they are; only a lease that
// moved is sent (leaseOf).
var saveLeasesSQL = db.OrderedConfigUpdate(`"allocatedCeilingBytes" = coalesce(v.allocated, c."allocatedCeilingBytes"),
       "walletBackedCeilingBytes" = CASE WHEN v.allocated IS NULL THEN c."walletBackedCeilingBytes" ELSE v.allocated END,
       "limitPeakBytes" = v.peak, "writePending" = v.pending`,
	`unnest($1::text[], $2::bigint[], $3::bigint[], $4::boolean[]) AS v(id, allocated, peak, pending)`)

// SaveLeases writes what one turn's plans decided (F-027-db). A peak below
// zero cannot happen — the planner's figures are counters plus a hold — and
// CHECK `config_lease_state_not_negative` would refuse one.
func (s PostgresStore) SaveLeases(ctx context.Context, leases []Lease) error {
	ids := make([]string, len(leases))
	allocated := make([]*int64, len(leases))
	peaks := make([]int64, len(leases))
	pending := make([]bool, len(leases))
	for i, l := range leases {
		ids[i], allocated[i], peaks[i], pending[i] = l.ConfigID, l.Allocated, l.Peak, l.Pending
	}
	if _, err := s.DB.Exec(ctx, saveLeasesSQL, ids, allocated, peaks, pending); err != nil {
		return fmt.Errorf("writing %d lease(s): %w", len(leases), err)
	}
	return nil
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
