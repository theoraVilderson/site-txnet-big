package leaseplan

import (
	"context"
	"fmt"
	"time"

	"network-service/internal/db"
	"network-service/internal/driver"
)

// DB is what the store needs of the pool: db.Pool satisfies it.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (db.Rows, error)
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
       p."panelState" = 'healthy'
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
		)
		if err := rows.Scan(&grantID, &quota, &endsAt, &c.ID, &c.PanelID, &live, &c.Exists, &c.Counter, &lifetime,
			&c.LimitSeen, &c.Enabled, &c.Allocated, &driverType, &pn.CanSetLimit, &pn.Healthy); err != nil {
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
		snap.Panels[pn.ID] = pn
	}
	return snap, rows.Err()
}
