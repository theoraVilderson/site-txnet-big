package leaseplan

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/driver"
	"network-service/internal/lease/quota"
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
// Quota is `purchasedBytes`, read; on a metered Grant — one with a
// `vpn.traffic` `grant_meter`, its locked rate (F-118-l) — its reserve is
// added to it (F-027-dc): what the Grant's own open hold on the owner's wallet
// buys at that rate (F-118-b, ADR-0105 (8)), computed from the columns'
// decimal text. Billing holds it (`ownerRef` = the Grant) and nothing
// else can spend it, so two Grants or a purchase cannot lease the same money.
// A Grant with no open reserve hold has a reserve of nothing. On a meter with
// a wholesale leg (F-118-n2) and a live config on a platform panel, the
// reserve is also bounded by what the reseller's `tenant_billing_wallet`
// funds (F-118-v, `WholesaleRoom`): the lesser of the two wallets. Used is summed in Go from each config's
// lifetime counter (`contract.lease.md`), which the pass that called us has
// already moved, plus, on a push panel, its sessions' high-water marks in
// `radius_session` (F-027-du). A config is a replica while it can carry
// traffic — the split's own rule (`contract.ceiling.md` "Who is in the
// split"). The counter a ceiling is measured on is the panel's last figure on
// a cumulative panel, the lifetime sum where a read zeroes it, and the
// sessions' sum less the sum the client was created at on a session panel,
// which is what User Manager checks its limit against. A Grant the planner closed
// carries its `lease_close` row, and its configs read disabled (F-027-dd).
const loadSQL = `
WITH touched AS (
  SELECT DISTINCT c."grantId" FROM network.config c
   WHERE c.id = ANY($2::uuid[])
      OR (c."panelId" = $1::uuid AND c."allocatedCeilingBytes" IS NULL AND NOT c."trafficUnlimited"
          AND c.status = 'active' AND c."desiredEnabled" AND c."desiredRemote" = 'present'))
SELECT g.id::text, g."purchasedBytes", g."endsAt", lc."quotaBytes", lc."expiresAt", lc."grantId" IS NOT NULL, coalesce(lc.reason::text, ''),
       g."billingMode" = 'metered' AND m."unitPrice" IS NOT NULL,
       coalesce(m."unitPrice"::text, ''), coalesce(h.amount::text, ''),
       m."wholesalePayerTenantId" IS NOT NULL, coalesce(m."wholesaleUnitSize", 0), coalesce(m."wholesaleUnitPrice"::text, ''),
       coalesce(m."wholesaleBilled", 0), coalesce(m."wholesaleConsumed", 0), coalesce(tw."cachedBalance"::text, ''),
       g."consumedBytes", p."ownershipType" = 'platform',
       c.id::text, c."panelId"::text,
       c.status = 'active' AND c."desiredEnabled" AND c."desiredRemote" = 'present',
       c."remoteId" IS NOT NULL,
       CASE p."counterSemantics"
            WHEN 'cumulative' THEN coalesce(s."lastUpBytes" + s."lastDownBytes", 0)
            WHEN 'session' THEN greatest(coalesce(rs.bytes, 0) - c."sessionBaselineBytes", 0)
            ELSE coalesce(s."lifetimeUpBytes" + s."lifetimeDownBytes", 0) END::bigint,
       (coalesce(s."lifetimeUpBytes" + s."lifetimeDownBytes", 0) + coalesce(rs.bytes, 0))::bigint,
       coalesce(c."appliedCeilingBytes", 0)::bigint, c."desiredEnabled" AND lc."grantId" IS NULL,
       c."allocatedCeilingBytes", c."limitPeakBytes", c."writePending",
       p."driverType"::text,
       p."counterSemantics" IN ('cumulative', 'session')
         AND coalesce((p.capabilities->'answers'->'per_client_data_limit'->>'supported')::boolean, false),
       p."panelState" = 'healthy',
       p."tickPeriodMs", p."tickPhaseMask",
       coalesce(p."lagMeanSec", 0), coalesce(p."lagVarianceSec2", 0), p."lagSamples",
       p."outageWeight", p."outageWeightAt"
  FROM touched t
  JOIN entitlement."grant" g ON g.id = t."grantId"
  LEFT JOIN entitlement.grant_meter m ON m."grantId" = g.id AND m."meterKey" = 'vpn.traffic'
  LEFT JOIN billing.wallet w ON w."ownerUserId" = g."userId"
  LEFT JOIN billing.wallet_hold h ON h."walletId" = w.id AND h."ownerRef" = g.id AND h.status = 'open'
  LEFT JOIN tenant.tenant_billing_wallet tw ON tw."tenantId" = m."wholesalePayerTenantId"
  LEFT JOIN network.lease_close lc ON lc."grantId" = g.id
  JOIN network.config c ON c."grantId" = g.id
  JOIN network.panel p ON p.id = c."panelId"
  LEFT JOIN network.config_counter_state s ON s."configId" = c.id
  LEFT JOIN LATERAL (SELECT sum(r."highWaterInBytes" + r."highWaterOutBytes") AS bytes
                       FROM network.radius_session r WHERE r."configId" = c.id) rs ON true
 WHERE g.status IN ('active', 'pending') AND NOT g."trafficUnlimited"
 ORDER BY g.id, c.id`

func (s PostgresStore) Load(ctx context.Context, panelID string, configIDs []string) (Snapshot, error) {
	rows, err := s.DB.Query(ctx, loadSQL, panelID, configIDs)
	if err != nil {
		return Snapshot{}, fmt.Errorf("reading the Grants of %d config(s) on panel %s: %w", len(configIDs), panelID, err)
	}
	defer rows.Close()
	snap := Snapshot{Panels: map[string]Panel{}}
	// What each Grant's reserve adds, settled once its configs are read: the
	// wholesale bound applies only if one of them is live on a platform panel.
	type owed struct {
		user, room    int64
		leg, platform bool
	}
	var reserves []owed
	for rows.Next() {
		var (
			grantID, driverType string
			metered             bool
			rate, reserve       string
			leg, platform       bool
			ws                  Wholesale
			consumed            int64
			purchased, lifetime int64
			applied             int64
			endsAt              *time.Time
			closedQuota         *int64
			closedEnd           *time.Time
			closed              bool
			closedWhy           string
			live                bool
			c                   Config
			pn                  Panel
			tickMs              *int32
			tickMask            *int64
			outageAt            *time.Time
		)
		if err := rows.Scan(&grantID, &purchased, &endsAt, &closedQuota, &closedEnd, &closed, &closedWhy, &metered, &rate, &reserve,
			&leg, &ws.UnitSize, &ws.UnitPrice, &ws.Billed, &ws.Consumed, &ws.Balance, &consumed, &platform, &c.ID, &c.PanelID, &live, &c.Exists, &c.Counter, &lifetime,
			&applied, &c.Enabled, &c.Allocated, &c.Peak, &c.Pending, &driverType, &pn.CanSetLimit, &pn.Healthy,
			&tickMs, &tickMask, &pn.Learned.LagMeanSec, &pn.Learned.LagVarianceSec2, &pn.Learned.LagSamples,
			&pn.Learned.OutageWeight, &outageAt); err != nil {
			return Snapshot{}, fmt.Errorf("reading a Grant's config: %w", err)
		}
		if n := len(snap.Grants); n == 0 || snap.Grants[n-1].ID != grantID {
			g := Grant{ID: grantID, Quota: purchased, Purchased: purchased, Metered: metered}
			r := owed{leg: leg}
			if metered {
				r.user = BytesAffordable(rate, reserve)
				if leg {
					r.room = WholesaleRoom(ws, purchased, consumed)
				}
			}
			reserves = append(reserves, r)
			if endsAt != nil {
				g.ExpiresAt = *endsAt
			}
			if closed {
				g.Closure = &Closure{Quota: *closedQuota, Reason: quota.CloseReason(closedWhy)}
				if closedEnd != nil {
					g.Closure.ExpiresAt = *closedEnd
				}
			}
			snap.Grants = append(snap.Grants, g)
		}
		g := &snap.Grants[len(snap.Grants)-1]
		g.Used += lifetime
		if !live {
			continue
		}
		reserves[len(reserves)-1].platform = reserves[len(reserves)-1].platform || platform
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
		if outageAt != nil {
			pn.Learned.OutageAt = *outageAt
		}
		snap.Panels[pn.ID] = pn
	}
	for i, r := range reserves {
		var bound *int64
		if r.leg && r.platform {
			bound = &r.room
		}
		snap.Grants[i].Quota += ReserveBytes(r.user, bound)
		snap.Grants[i].Unfunded = bound != nil && *bound == 0
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

// ClosedEvent is the outbox type a close is announced under (F-027-dw,
// ADR-0096): worker-service asks billing to settle that Grant, and a prepaid
// one still on its Quota becomes `suspended` for quota. Declared in
// shared-core's `OutboxEventType.GRANT_CLOSED`.
const ClosedEvent = "network.grant.closed"

// saveClosureSQL writes a Grant's close (F-027-dd) and announces it in the
// same statement ($4, ADR-0021), so the event and the row commit or fail
// together. The owner is read from `entitlement.grant."userId"`, a column
// ADR-0094 already lists; the tenant is not (billing finds it from the Grant).
// The row says why it closed (F-027-dz), and billing reads that from the row.
// deleteClosureSQL reopens it, silently — a renewal revived the Grant
// itself, and a close with bytes left that settled (F-027-dx) left billing
// nothing to undo on a metered one. The planner is the only writer of
// `network.lease_close`.
const (
	saveClosureSQL = `
WITH saved AS (
INSERT INTO network.lease_close ("grantId", "quotaBytes", "expiresAt", reason, "closedAt")
VALUES ($1::uuid, $2, $3, $5::network."LeaseCloseReason", now())
ON CONFLICT ("grantId") DO UPDATE
   SET "quotaBytes" = excluded."quotaBytes", "expiresAt" = excluded."expiresAt", reason = excluded.reason,
       "closedAt" = excluded."closedAt"
RETURNING "grantId", "quotaBytes")
INSERT INTO automation.outbox_event (id, aggregate, "aggregateId", type, payload)
SELECT gen_random_uuid(), 'network.lease_close', s."grantId"::text, $4::text,
       jsonb_build_object(
         'userId', g."userId"::text,
         'grantId', s."grantId"::text,
         'quotaBytes', s."quotaBytes"::text)
  FROM saved s
  JOIN entitlement."grant" g ON g.id = s."grantId"`
	deleteClosureSQL = `DELETE FROM network.lease_close WHERE "grantId" = $1::uuid`
)

// SaveClosure writes or deletes one Grant's close.
func (s PostgresStore) SaveClosure(ctx context.Context, grantID string, c *Closure) error {
	var err error
	if c == nil {
		_, err = s.DB.Exec(ctx, deleteClosureSQL, grantID)
	} else {
		var end *time.Time
		if !c.ExpiresAt.IsZero() {
			end = &c.ExpiresAt
		}
		_, err = s.DB.Exec(ctx, saveClosureSQL, grantID, c.Quota, end, ClosedEvent, string(c.Reason))
	}
	if err != nil {
		return fmt.Errorf("writing the close of Grant %s: %w", grantID, err)
	}
	return nil
}

// saveLearnedSQL writes the panel's learned state, and only when it differs
// from the row: the pass that learned nothing new writes nothing. No trigger
// reads these columns (`sub_panel_changed` is on `panelState` and `region`).
const saveLearnedSQL = `
UPDATE network.panel
   SET "tickPeriodMs" = $2, "tickPhaseMask" = $3,
       "lagMeanSec" = $4, "lagVarianceSec2" = $5, "lagSamples" = $6,
       "outageWeight" = $7, "outageWeightAt" = $8
 WHERE id = $1::uuid
   AND ("tickPeriodMs", "tickPhaseMask", "lagMeanSec", "lagVarianceSec2", "lagSamples",
        "outageWeight", "outageWeightAt")
       IS DISTINCT FROM ($2::int, $3::bigint, $4::float8, $5::float8, $6::int, $7::float8, $8::timestamp)`

// SaveLearned keeps what the planner learned of a panel (F-027-cz). The lag
// is null with no sample (CHECK `panel_lag_matches_samples`), and the outage
// time with no outage (CHECK `panel_outage_weight_has_time`).
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
	var outageAt *time.Time
	if l.OutageWeight > 0 {
		at := l.OutageAt.UTC()
		outageAt = &at
	}
	if _, err := s.DB.Exec(ctx, saveLearnedSQL, panelID, period, mask, mean, variance, l.LagSamples,
		l.OutageWeight, outageAt); err != nil {
		return fmt.Errorf("saving panel %s's tick, lag and outages: %w", panelID, err)
	}
	return nil
}
