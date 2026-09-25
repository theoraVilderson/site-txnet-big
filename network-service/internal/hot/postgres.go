package hot

import (
	"context"
	"fmt"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
)

// PanelLister is the panels the bulk pass last offered, with their drivers —
// `collect.PostgresSource.Offered`. The hot loop opens nothing of its own: a
// panel has one driver and one request budget whichever loop is asking
// (invariant 34), and a panel the bulk pass has not accepted into a pass is
// not read early by anyone.
type PanelLister interface {
	Offered() []collect.Panel
}

// PostgresSource is Source over `network.config` (F-027-bu): every config on
// an offered panel that holds a share, a client and is still wanted there,
// with its headroom, its measured rate and its cursor. Membership is decided
// by the loop (`IsHot`), not here, so the rule lives in one place.
type PostgresSource struct {
	DB      collect.DB
	Panels  PanelLister
	Cursors *collect.PostgresCursors
}

var _ Source = (*PostgresSource)(nil)

// candidatesSQL is the ceiling pass's population (`converge.allocationsSQL`),
// plus what time to ceiling is computed from. Headroom is the share less the
// lifetime bytes the cursor says were served, up and down together.
const candidatesSQL = `
SELECT c."panelId"::text, c.id::text, c."remoteId", c.protocol::text,
       c."allocatedCeilingBytes", coalesce(c."observedRateBps", 0)::bigint,
       s.id IS NOT NULL, coalesce(s."counterSemantics"::text, ''),
       coalesce(s."lastUpBytes", 0), coalesce(s."lastDownBytes", 0),
       coalesce(s."lifetimeUpBytes", 0), coalesce(s."lifetimeDownBytes", 0),
       s."lastObservedAt", coalesce(s."resetCount", 0), s."lastResetAt"
  FROM network.config c
  LEFT JOIN network.config_counter_state s ON s."configId" = c.id
 WHERE c."panelId" = ANY($1::uuid[])
   AND c."allocatedCeilingBytes" IS NOT NULL
   AND c."remoteId" IS NOT NULL
   AND c."desiredRemote" = 'present'
   AND c."desiredEnabled"`

// Candidates reads the rows and their cursors in one statement, under the
// cursors' lock (`PostgresCursors.Merge`). A client re-keyed since the last
// bulk pass is then found with its cursor rather than adopted again from
// zero, which would restart its lifetime and the ceiling offset built on it.
//
// Each candidate carries a copy of its panel whose Configs are this
// statement's, never the bulk pass's map: a config created since that pass is
// billed on the hot one rather than written down as unattributed.
func (s *PostgresSource) Candidates(ctx context.Context) ([]Candidate, error) {
	offered := s.Panels.Offered()
	if len(offered) == 0 {
		return nil, nil
	}
	byID := make(map[string]collect.Panel, len(offered))
	ids := make([]string, len(offered))
	for i, p := range offered {
		byID[p.ID], ids[i] = p, p.ID
	}

	type row struct {
		panelID, remoteID string
		ref               collect.ConfigRef
		allocated, rate   int64
		served            int64
	}
	var rows []row
	err := s.Cursors.Merge(func() (map[collect.CursorKey]collect.Counter, error) {
		found, err := s.DB.Query(ctx, candidatesSQL, ids)
		if err != nil {
			return nil, fmt.Errorf("reading hot candidates: %w", err)
		}
		defer found.Close()
		cursors := map[collect.CursorKey]collect.Counter{}
		for found.Next() {
			var r row
			var has bool
			var semantics string
			var cur collect.Counter
			var observed, reset *time.Time
			if err := found.Scan(&r.panelID, &r.ref.ConfigID, &r.remoteID, &r.ref.Protocol,
				&r.allocated, &r.rate, &has, &semantics,
				&cur.LastUpBytes, &cur.LastDownBytes, &cur.LifetimeUpBytes, &cur.LifetimeDownBytes,
				&observed, &cur.ResetCount, &reset); err != nil {
				return nil, fmt.Errorf("reading hot candidates: %w", err)
			}
			r.served = cur.LifetimeUpBytes + cur.LifetimeDownBytes
			rows = append(rows, r)
			if !has {
				continue
			}
			cur.Semantics = driver.CounterSemantics(semantics)
			if observed != nil {
				cur.LastObservedAt = observed.UTC()
			}
			if reset != nil {
				cur.LastResetAt = reset.UTC()
			}
			cursors[collect.CursorKey{PanelID: r.panelID, RemoteID: r.remoteID}] = cur
		}
		if err := found.Err(); err != nil {
			return nil, fmt.Errorf("reading hot candidates: %w", err)
		}
		return cursors, nil
	})
	if err != nil {
		return nil, err
	}

	configs := map[string]map[string]collect.ConfigRef{}
	for _, r := range rows {
		if configs[r.panelID] == nil {
			configs[r.panelID] = map[string]collect.ConfigRef{}
		}
		configs[r.panelID][r.remoteID] = r.ref
	}
	out := make([]Candidate, 0, len(rows))
	for _, r := range rows {
		panel, ok := byID[r.panelID]
		if !ok {
			continue
		}
		panel.Configs = configs[r.panelID]
		out = append(out, Candidate{
			Panel: panel, ConfigID: r.ref.ConfigID, RemoteID: r.remoteID,
			HeadroomBytes: r.allocated - r.served, RateBps: r.rate,
		})
	}
	return out, nil
}
