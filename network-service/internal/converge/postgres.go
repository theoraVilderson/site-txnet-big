package converge

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
)

// The convergence pass's state on `network.config` (F-027-bo), through the
// cross-tenant pool: one pass spans every tenant's configs on a panel. These
// replace `MemoryDesired` and `MemoryAllocations`, which stay as what the
// pass is proved against.
//
// Every write names the row by id and nothing else moves: the actions
// (`contract.provisioning.md`) own the desired state, the allocator owns the
// share, and the pass writes only what it learned.

// DB is what the stores need of the pool: db.Pool satisfies it, and a test
// can too.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (db.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresDesired is Desired over `network.config`.
type PostgresDesired struct {
	DB DB
}

var _ Desired = PostgresDesired{}

// desiredSQL is every row on the panel but a delete already confirmed:
// `absent`, no `remoteId`, `complete` is finished until an action writes the
// row again, and every action that does moves it off `complete`. Served bytes
// are the counter cursor's lifetime figure, the basis the share is counted on;
// a config never collected has served none.
//
// The inbound is the config's own (F-114-b). A row placed before it names
// none, and takes the lowest picked inbound of its protocol on the panel —
// still only a picked one: with nothing picked it is '' and `no_inbound`.
const desiredSQL = `
SELECT c.id::text, coalesce(c."remoteId", ''), c."claimTag", c.uuid, c.protocol::text,
       coalesce(c."inboundRemoteId",
                (SELECT i."remoteId" FROM network.panel_inbound i
                  WHERE i."panelId" = c."panelId" AND i.sold AND i."goneAt" IS NULL AND i.protocol = c.protocol
                  ORDER BY length(i."remoteId"), i."remoteId" LIMIT 1),
                ''),
       c."desiredEnabled", c."desiredRemote" = 'present', c."allocatedCeilingBytes",
       coalesce(s."lifetimeUpBytes" + s."lifetimeDownBytes", 0)::bigint,
       c."enforcementState"::text, c."driftState"::text, c."driftRepairCount", c."driftRepairedAt",
       c."linkLines", coalesce(c."linksRemoteId", ''), coalesce(c."linksUuid", ''), c."linksCapturedAt"
  FROM network.config c
  LEFT JOIN network.config_counter_state s ON s."configId" = c.id
 WHERE c."panelId" = $1::uuid
   AND NOT (c."desiredRemote" = 'absent' AND c."remoteId" IS NULL AND c."enforcementState" = 'complete')
 ORDER BY c."createdAt", c.id`

func (s PostgresDesired) For(ctx context.Context, panelID string) ([]DesiredConfig, error) {
	rows, err := s.DB.Query(ctx, desiredSQL, panelID)
	if err != nil {
		return nil, fmt.Errorf("reading panel %s desired state: %w", panelID, err)
	}
	defer rows.Close()
	var out []DesiredConfig
	for rows.Next() {
		var d DesiredConfig
		var state, drift string
		var repairedAt, capturedAt *time.Time
		if err := rows.Scan(&d.ConfigID, &d.RemoteID, &d.ClaimTag, &d.UUID, &d.Protocol, &d.InboundRemoteID,
			&d.Enabled, &d.Present, &d.AllocatedBytes, &d.ServedBytes,
			&state, &drift, &d.RepairCount, &repairedAt,
			&d.Links.Lines, &d.Links.RemoteID, &d.Links.UUID, &capturedAt); err != nil {
			return nil, fmt.Errorf("reading panel %s desired state: %w", panelID, err)
		}
		d.State, d.Drift = EnforcementState(state), DriftState(drift)
		if repairedAt != nil {
			d.RepairedAt = *repairedAt
		}
		if capturedAt != nil {
			d.Links.At = *capturedAt
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading panel %s desired state: %w", panelID, err)
	}
	return out, nil
}

// recordSQL writes one outcome over the desired state it was judged against,
// in the same statement: an action that wrote in between leaves no row to
// update, and the next pass judges what it wrote. The lines move only with a
// capture ($8), and then with their key and time together
// (`config_links_captured_from_a_client`).
const recordSQL = `
UPDATE network.config
   SET "remoteId" = NULLIF($2, ''),
       "enforcementState" = $3::network."EnforcementState",
       "lastReconciledAt" = $4,
       "linkLines" = CASE WHEN $8 THEN $9::text[] ELSE "linkLines" END,
       "linksRemoteId" = CASE WHEN $8 THEN $10 ELSE "linksRemoteId" END,
       "linksUuid" = CASE WHEN $8 THEN $11 ELSE "linksUuid" END,
       "linksCapturedAt" = CASE WHEN $8 THEN $12 ELSE "linksCapturedAt" END
 WHERE id = $1::uuid
   AND uuid = $5 AND "desiredEnabled" = $6 AND ("desiredRemote" = 'present') = $7`

// Record writes each outcome on its own: a capture carries an array per row,
// which one set-based statement cannot. An outcome whose row moved on is
// dropped, not failed — nothing about it is wrong except that it is stale.
func (s PostgresDesired) Record(ctx context.Context, rows []Outcome) error {
	for _, o := range rows {
		captured, lines := o.Links != nil, []string{}
		var linksRemote, linksUUID string
		var linksAt *time.Time
		if captured {
			if o.Links.Lines != nil {
				lines = o.Links.Lines
			}
			linksRemote, linksUUID = o.Links.RemoteID, o.Links.UUID
			at := o.Links.At
			linksAt = &at
		}
		if _, err := s.DB.Exec(ctx, recordSQL,
			o.ConfigID, o.RemoteID, string(o.State), o.At,
			o.UUID, o.Enabled, o.Present,
			captured, lines, linksRemote, linksUUID, linksAt); err != nil {
			return fmt.Errorf("recording config %s: %w", o.ConfigID, err)
		}
	}
	return nil
}

// driftSQL writes every verdict of a pass in one statement, with the repair
// count and time the anti-flap stop reads back (F-027-ab).
const driftSQL = `
UPDATE network.config c
   SET "driftState" = v.drift::network."DriftState",
       "driftRepairCount" = v.count,
       "driftRepairedAt" = v.repaired
  FROM unnest($1::text[], $2::text[], $3::int[], $4::timestamp(3)[]) AS v(id, drift, count, repaired)
 WHERE c.id = v.id::uuid`

func (s PostgresDesired) RecordDrift(ctx context.Context, rows []Verdict) error {
	if len(rows) == 0 {
		return nil
	}
	ids, drifts := make([]string, len(rows)), make([]string, len(rows))
	counts, repaired := make([]int32, len(rows)), make([]*time.Time, len(rows))
	for i, v := range rows {
		ids[i], drifts[i], counts[i] = v.ConfigID, string(v.Drift), int32(v.RepairCount)
		if !v.RepairedAt.IsZero() {
			at := v.RepairedAt
			repaired[i] = &at
		}
	}
	if _, err := s.DB.Exec(ctx, driftSQL, ids, drifts, counts, repaired); err != nil {
		return fmt.Errorf("recording drift verdicts: %w", err)
	}
	return nil
}

// PostgresAllocations is Allocations over `network.config`.
type PostgresAllocations struct {
	DB DB
}

var _ Allocations = PostgresAllocations{}

// allocationsSQL is the configs the ceiling pass can write to: a share, a
// client, and still wanted on the panel. One being deleted is provisioning's.
const allocationsSQL = `
SELECT c.id::text, c."remoteId", c."allocatedCeilingBytes", c."appliedCeilingBytes"
  FROM network.config c
 WHERE c."panelId" = $1::uuid
   AND c."allocatedCeilingBytes" IS NOT NULL
   AND c."remoteId" IS NOT NULL
   AND c."desiredRemote" = 'present'
 ORDER BY c."createdAt", c.id`

func (s PostgresAllocations) For(ctx context.Context, panelID string) ([]Allocation, error) {
	rows, err := s.DB.Query(ctx, allocationsSQL, panelID)
	if err != nil {
		return nil, fmt.Errorf("reading panel %s allocations: %w", panelID, err)
	}
	defer rows.Close()
	var out []Allocation
	for rows.Next() {
		var a Allocation
		if err := rows.Scan(&a.ConfigID, &a.RemoteID, &a.AllocatedBytes, &a.AppliedBytes); err != nil {
			return nil, fmt.Errorf("reading panel %s allocations: %w", panelID, err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading panel %s allocations: %w", panelID, err)
	}
	return out, nil
}

// appliedSQL records what the panel was read enforcing — a read, never our
// write (invariant 36).
const appliedSQL = `
UPDATE network.config c
   SET "appliedCeilingBytes" = v.bytes,
       "ceilingAppliedAt" = v.at
  FROM unnest($1::text[], $2::bigint[], $3::timestamp(3)[]) AS v(id, bytes, at)
 WHERE c.id = v.id::uuid`

func (s PostgresAllocations) Record(ctx context.Context, rows []AppliedCeiling) error {
	if len(rows) == 0 {
		return nil
	}
	ids, bytes, at := make([]string, len(rows)), make([]int64, len(rows)), make([]time.Time, len(rows))
	for i, r := range rows {
		ids[i], bytes[i], at[i] = r.ConfigID, r.Bytes, r.At
	}
	if _, err := s.DB.Exec(ctx, appliedSQL, ids, bytes, at); err != nil {
		return fmt.Errorf("recording applied ceilings: %w", err)
	}
	return nil
}
