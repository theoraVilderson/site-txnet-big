package converge

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/driver"
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
// are the counter cursor's lifetime figure, the basis the share is counted on,
// plus the Σ of its `radius_session` marks on a push panel (F-027-du); a
// config never collected has served none.
//
// The inbound is the config's own (F-114-b). A row placed before it names
// none, and takes the lowest picked inbound of its protocol on the panel —
// still only a picked one: with nothing picked it is ” and `no_inbound` —
// and only one in the pool: never an inbound a group holds (F-027-ch). Which
// group the row is for lives outside `network.*` (ADR-0071), so it is never
// placed on its own group's either; the pass writes down where its client is
// (recordSQL), and such a row is a guess only until then.
//
// Enabled is `desiredEnabled` while the lease planner has not closed the
// Grant (`network.lease_close`, F-027-dd): a closed Grant's clients are
// disabled, and billing's own switch is left as it was.
const desiredSQL = `
SELECT c.id::text, coalesce(c."remoteId", ''), c."claimTag", c.uuid, c.protocol::text,
       coalesce(c."inboundRemoteId",
                (SELECT i."remoteId" FROM network.panel_inbound i
                  WHERE i."panelId" = c."panelId" AND i.sold AND i."goneAt" IS NULL AND i.protocol = c.protocol
                    AND NOT EXISTS (SELECT 1 FROM network.panel_group_member_inbound a
                                     WHERE a."panelId" = i."panelId" AND a."inboundRemoteId" = i."remoteId")
                  ORDER BY length(i."remoteId"), i."remoteId" LIMIT 1),
                ''),
       c."desiredEnabled" AND NOT EXISTS (SELECT 1 FROM network.lease_close l WHERE l."grantId" = c."grantId"),
       c."desiredRemote" = 'present', c."allocatedCeilingBytes",
       (coalesce(s."lifetimeUpBytes" + s."lifetimeDownBytes", 0) + coalesce(rs.bytes, 0))::bigint,
       coalesce(rs.bytes, 0)::bigint, c."sessionBaselineBytes",
       c."enforcementState"::text, c."driftState"::text, c."driftRepairCount", c."driftRepairedAt",
       c."linkLines", coalesce(c."linksRemoteId", ''), coalesce(c."linksUuid", ''), c."linksCapturedAt",
       c."trafficUnlimited", c."inboundRemoteId" IS NULL, coalesce(c."credentialGroupId"::text, ''),
       coalesce(c."observedRateBps", 0)::bigint,
       coalesce(rl."rateMbps"::bigint * 1000000, 0),
       CASE WHEN jsonb_typeof(g.quotas #> '{concurrent_devices,limit}') = 'number'
            THEN greatest((g.quotas #>> '{concurrent_devices,limit}')::numeric, 0)::int ELSE 0 END
  FROM network.config c
  LEFT JOIN network.grant_rate_limit rl ON rl."grantId" = c."grantId"
  LEFT JOIN entitlement."grant" g ON g.id = c."grantId"
  LEFT JOIN network.config_counter_state s ON s."configId" = c.id
  LEFT JOIN LATERAL (SELECT sum(r."highWaterInBytes" + r."highWaterOutBytes") AS bytes
                       FROM network.radius_session r WHERE r."configId" = c.id) rs ON true
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
			&d.Enabled, &d.Present, &d.AllocatedBytes, &d.ServedBytes, &d.SessionBytes, &d.SessionBaselineBytes,
			&state, &drift, &d.RepairCount, &repairedAt,
			&d.Links.Lines, &d.Links.RemoteID, &d.Links.UUID, &capturedAt, &d.Unlimited, &d.InboundResolved, &d.CredentialGroupID, &d.RateBps, &d.RateCapBps, &d.IPLimit); err != nil {
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

// LinksCapturedEvent is the outbox type a capture is announced under
// (F-111-l): automation pushes it on the owner's `user:` channel and an open
// My services re-reads that Grant's configs. Declared in
// contracts/realtime/events.json.
const LinksCapturedEvent = "network.grant.linksCaptured"

// ConfirmedEvent is the outbox type a config's confirming read is announced
// under (F-111-n): worker-service asks billing to fulfil that one Grant, which
// activates it once `minHealthyPanels` confirm (contract.groups.md rule 10).
const ConfirmedEvent = "network.config.confirmed"

// recordSQL writes one outcome over the desired state it was judged against,
// in the same statement: an action that wrote in between leaves no row to
// update, and the next pass judges what it wrote. The lines move only with a
// capture ($8), and then with their key and time together
// (`config_links_captured_from_a_client`). A capture ($8) and a confirmation
// of a Grant's config ($15) are announced in the same statement, so the event
// and the row commit or fail together (ADR-0021); a dropped outcome updates no
// row and announces nothing. Only a config's first confirmation is announced
// (`confirmedAt`, F-111-o): `prior` is the row before this statement, so a
// later disable, rotation or repair has no Grant waiting on it and is silent.
// The inbound a client was found on ($16, F-027-ch) is written only over none,
// and not where another live row of the Grant holds it on the panel: that is
// `config_group_panel_once`, and one row's guess must not fail the batch.
// A create's session baseline ($17, F-027-du) is written with it, and the
// router's last total forgotten: the new client's is read afresh. Null keeps both.
const recordSQL = `
WITH prior AS (SELECT "confirmedAt" FROM network.config WHERE id = $1::uuid),
recorded AS (
UPDATE network.config
   SET "remoteId" = NULLIF($2, ''),
       "enforcementState" = $3::network."EnforcementState",
       "lastReconciledAt" = $4,
       "linkLines" = CASE WHEN $8 THEN $9::text[] ELSE "linkLines" END,
       "linksRemoteId" = CASE WHEN $8 THEN $10 ELSE "linksRemoteId" END,
       "linksUuid" = CASE WHEN $8 THEN $11 ELSE "linksUuid" END,
       "linksCapturedAt" = CASE WHEN $8 THEN $12 ELSE "linksCapturedAt" END,
       "confirmedAt" = CASE WHEN $15 THEN COALESCE("confirmedAt", $4) ELSE "confirmedAt" END,
       "inboundRemoteId" = CASE
         WHEN "inboundRemoteId" IS NULL AND $16 <> ''
          AND NOT EXISTS (SELECT 1 FROM network.config o
                           WHERE o."grantId" = config."grantId" AND o."panelId" = config."panelId" AND o.id <> config.id
                             AND o."inboundRemoteId" = $16 AND o."credentialGroupId" IS NOT NULL AND o."drainedAt" IS NULL)
         THEN $16 ELSE "inboundRemoteId" END,
       "sessionBaselineBytes" = coalesce($17::bigint, "sessionBaselineBytes"),
       "sessionCounterBytes" = CASE WHEN $17::bigint IS NULL THEN "sessionCounterBytes" END
 WHERE id = $1::uuid
   AND uuid = $5
   AND ("desiredEnabled" AND NOT EXISTS (SELECT 1 FROM network.lease_close l WHERE l."grantId" = config."grantId")) = $6
   AND ("desiredRemote" = 'present') = $7
RETURNING id, "tenantId", "userId", "grantId")
INSERT INTO automation.outbox_event (id, aggregate, "aggregateId", type, payload)
SELECT gen_random_uuid(), 'network.config', r.id::text, e.type,
       jsonb_build_object(
         'tenantId', r."tenantId"::text,
         'userId', r."userId"::text,
         'grantId', r."grantId"::text,
         'configId', r.id::text)
  FROM recorded r
 CROSS JOIN prior
 CROSS JOIN (VALUES ($13::text, $8::boolean, false), ($14::text, $15::boolean, true)) AS e(type, due, confirm)
 WHERE e.due AND (NOT e.confirm OR (r."grantId" IS NOT NULL AND prior."confirmedAt" IS NULL))`

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
			captured, lines, linksRemote, linksUUID, linksAt, LinksCapturedEvent, ConfirmedEvent, o.Confirmed, o.InboundRemoteID, o.SessionBaseline); err != nil {
			return fmt.Errorf("recording config %s: %w", o.ConfigID, err)
		}
	}
	return nil
}

// driftSQL writes every verdict of a pass in one statement, with the repair
// count and time the anti-flap stop reads back (F-027-ab).
var driftSQL = db.OrderedConfigUpdate(`"driftState" = v.drift::network."DriftState",
       "driftRepairCount" = v.count,
       "driftRepairedAt" = v.repaired`,
	`unnest($1::text[], $2::text[], $3::int[], $4::timestamp(3)[]) AS v(id, drift, count, repaired)`)

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

var _ Claims = PostgresDesired{}

// holderSQL is the other panel with the most configs whose claim tag or uuid
// the orphans carry — the same match as the connection test's
// (`register.claimHolderSQL`), counted. Both columns are unique, so each is
// one index probe per key.
const holderSQL = `
SELECT c."panelId"::text, count(*)::int
  FROM network.config c
 WHERE c."panelId" <> $1::uuid
   AND (c."claimTag" = ANY($2::text[]) OR c.uuid = ANY($3::text[]))
 GROUP BY c."panelId"
 ORDER BY count(*) DESC, c."panelId"
 LIMIT 1`

func (s PostgresDesired) Holder(ctx context.Context, panelID string, clients []driver.RemoteClient) (ForeignHolder, bool, error) {
	tags, uuids := []string{}, []string{}
	for _, c := range clients {
		if c.Label != "" {
			tags = append(tags, c.Label)
		}
		if c.UUID != "" {
			uuids = append(uuids, c.UUID)
		}
	}
	if len(tags)+len(uuids) == 0 {
		return ForeignHolder{}, false, nil
	}
	rows, err := s.DB.Query(ctx, holderSQL, panelID, tags, uuids)
	if err != nil {
		return ForeignHolder{}, false, fmt.Errorf("reading whose clients panel %s holds: %w", panelID, err)
	}
	defer rows.Close()
	var h ForeignHolder
	found := rows.Next()
	if found {
		if err := rows.Scan(&h.PanelID, &h.Clients); err != nil {
			return ForeignHolder{}, false, fmt.Errorf("reading whose clients panel %s holds: %w", panelID, err)
		}
	}
	return h, found, rows.Err()
}

// PostgresAllocations is Allocations over `network.config`.
type PostgresAllocations struct {
	DB DB
}

var _ Allocations = PostgresAllocations{}

// allocationsSQL is the configs the ceiling pass can write to: a share, a
// client, and still wanted on the panel. One being deleted is provisioning's.
const allocationsSQL = `
SELECT c.id::text, c."remoteId", c."allocatedCeilingBytes", c."appliedCeilingBytes",
       c."writtenCeilingBytes", coalesce(c."observedRateBps", 0)::bigint
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
		if err := rows.Scan(&a.ConfigID, &a.RemoteID, &a.AllocatedBytes, &a.AppliedBytes, &a.WrittenBytes, &a.RateBps); err != nil {
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
// write (invariant 36). In id order: a hot, bulk or woken turn and billing's
// re-split all write these rows (F-027-cv).
var appliedSQL = db.OrderedConfigUpdate(`"appliedCeilingBytes" = v.bytes,
       "ceilingAppliedAt" = v.at`,
	`unnest($1::text[], $2::bigint[], $3::timestamp(3)[]) AS v(id, bytes, at)`)

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

// writtenSQL remembers the figure we wrote, so the next pass knows it for ours
// (F-027-cu). It is never `appliedCeilingBytes`: a write is not a read.
var writtenSQL = db.OrderedConfigUpdate(`"writtenCeilingBytes" = v.bytes`,
	`unnest($1::text[], $2::bigint[]) AS v(id, bytes)`)

func (s PostgresAllocations) Wrote(ctx context.Context, rows []WrittenCeiling) error {
	if len(rows) == 0 {
		return nil
	}
	ids, bytes := make([]string, len(rows)), make([]int64, len(rows))
	for i, r := range rows {
		ids[i], bytes[i] = r.ConfigID, r.Bytes
	}
	if _, err := s.DB.Exec(ctx, writtenSQL, ids, bytes); err != nil {
		return fmt.Errorf("recording written ceilings: %w", err)
	}
	return nil
}
