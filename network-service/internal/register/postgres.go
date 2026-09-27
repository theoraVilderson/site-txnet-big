package register

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/driver"
)

// DB is what PostgresStore needs of the pool: db.Pool satisfies it, and a
// test can too.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (db.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresStore is Store over `network.panel` (F-027-ax), through the
// cross-tenant pool: registration spans every tenant's panels.
//
// Both writes carry `"reviewState" = 'pending'` and the two addresses that
// were tested in their WHERE, so the rule that an answer lands only over
// pending, for the server it reached (contract.registration.md rule 3,
// F-027-cc), is the database's to hold, in the same statement, not a read
// before it.
type PostgresStore struct {
	DB DB
}

var _ Store = PostgresStore{}

// maxDetail bounds `connectionTestDetail`. A far end's error body is not ours
// to store whole.
const maxDetail = 1000

const pendingSQL = `
SELECT id::text, "driverType"::text, transport::text, "counterSemantics"::text,
       coalesce("apiBaseUrl", ''), coalesce("clientBaseUrl", ''), "panelApiCredentials",
       "connectionTestedAt", coalesce("connectionTestFault"::text, ''), coalesce("tenantId"::text, '')
  FROM network.panel
 WHERE "reviewState" = 'pending'
   AND "retiredAt" IS NULL
 ORDER BY id`

func (s PostgresStore) Pending(ctx context.Context) ([]Candidate, error) {
	rows, err := s.DB.Query(ctx, pendingSQL)
	if err != nil {
		return nil, fmt.Errorf("reading pending panels: %w", err)
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		var family, transport, semantics, fault string
		var testedAt *time.Time
		if err := rows.Scan(&c.PanelID, &family, &transport, &semantics,
			&c.APIBaseURL, &c.ClientBaseURL, &c.Credentials, &testedAt, &fault, &c.TenantID); err != nil {
			return nil, fmt.Errorf("reading pending panels: %w", err)
		}
		c.DriverType = driver.DriverType(family)
		c.Transport = driver.Transport(transport)
		c.CounterSemantics = driver.CounterSemantics(semantics)
		c.Fault = FaultKind(fault)
		if testedAt != nil {
			c.TestedAt = *testedAt
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading pending panels: %w", err)
	}
	return out, nil
}

// PanelTestedEvent is the outbox type every test result is announced under
// (F-027-bs): automation pushes it on the owner's `tenant:` channel and the
// systems page re-reads on it. Declared in contracts/realtime/events.json.
const PanelTestedEvent = "network.panel.tested"

// announceSQL follows a `tested` CTE — the write it announces — so the event
// and the state change commit or fail together (ADR-0021). A platform panel's
// tenantId is null (invariant 9); its owner is the platform_owner tenant,
// named here so the consumer never guesses whose page it is. The tenant's
// ownerUserId and the panel's name ride along (F-067-o): a verdict is also
// told in the owner's inbox and bot, and a message needs to say which panel.
const announceSQL = `
INSERT INTO automation.outbox_event (id, aggregate, "aggregateId", type, payload)
SELECT gen_random_uuid(), 'network.panel', t.id::text, $%d::text,
       jsonb_build_object(
         'panelId', t.id::text,
         'panelName', t.name,
         'tenantId', o.id::text,
         'ownerUserId', o."ownerUserId"::text,
         'reviewState', t."reviewState"::text,
         'fault', t."connectionTestFault"::text)
  FROM tested t
  LEFT JOIN LATERAL (
    SELECT o.id, o."ownerUserId" FROM tenant.tenant o
     WHERE o.id = t."tenantId"
        OR (t."tenantId" IS NULL AND o."tenantType" = 'platform_owner')
     ORDER BY o."createdAt", o.id LIMIT 1) o ON true`

// testedAddressSQL holds a write to the addresses the test ran against ($5,
// $6; "" for none, as Pending reads a null). An edit that changed either
// sends the panel back to pending (billing contract.panel-lifecycle.md rule
// 2), so pending alone would let the old server's answer land on the new one.
const testedAddressSQL = `
   AND coalesce("apiBaseUrl", '') = $5 AND coalesce("clientBaseUrl", '') = $6`

var answerSQL = `
WITH tested AS (
UPDATE network.panel
   SET capabilities = $2::jsonb,
       "reviewState" = $3::network."PanelReviewState",
       "connectionTestedAt" = $4,
       "connectionTestFault" = NULL,
       "connectionTestDetail" = NULL
 WHERE id = $1::uuid AND "reviewState" = 'pending'` + testedAddressSQL + `
RETURNING id, name, "tenantId", "reviewState", "connectionTestFault")` + fmt.Sprintf(announceSQL, 7)

// Answer writes the verdict and announces it. false is a panel no longer
// pending — withdrawn or already answered — or no longer at the address
// tested, and the answer is dropped (rule 3): the CTE returns no row, so
// nothing is announced either.
func (s PostgresStore) Answer(ctx context.Context, p Pending, caps driver.Capabilities, state driver.ReviewState, at time.Time) (bool, error) {
	doc, err := json.Marshal(caps)
	if err != nil {
		return false, fmt.Errorf("encoding capabilities: %w", err)
	}
	tag, err := s.DB.Exec(ctx, answerSQL, p.PanelID, doc, string(state), at,
		p.APIBaseURL, p.ClientBaseURL, PanelTestedEvent)
	if err != nil {
		return false, fmt.Errorf("writing panel %s verdict: %w", p.PanelID, err)
	}
	return tag.RowsAffected() == 1, nil
}

var failSQL = `
WITH tested AS (
UPDATE network.panel
   SET "connectionTestedAt" = $4,
       "connectionTestFault" = $2::network."ConnectionTestFault",
       "connectionTestDetail" = $3
 WHERE id = $1::uuid AND "reviewState" = 'pending'` + testedAddressSQL + `
RETURNING id, name, "tenantId", "reviewState", "connectionTestFault")` + fmt.Sprintf(announceSQL, 7)

// Fail records a test that produced no verdict. A panel no longer pending is
// left as it is: a fault lives only on a pending panel (rule 5). One whose
// address changed is left too: the new server has not failed anything.
func (s PostgresStore) Fail(ctx context.Context, p Pending, fault FaultKind, detail string, at time.Time) (bool, error) {
	tag, err := s.DB.Exec(ctx, failSQL, p.PanelID, string(fault), truncate(detail, maxDetail), at,
		p.APIBaseURL, p.ClientBaseURL, PanelTestedEvent)
	if err != nil {
		return false, fmt.Errorf("writing panel %s fault: %w", p.PanelID, err)
	}
	return tag.RowsAffected() == 1, nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	s = s[:max]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}

// claimHolderSQL is a config of another panel carrying one of the tags or
// uuids the new panel's clients hold. Every config counts, retired ones too:
// a client of ours left behind is still proof of which server this is.
const claimHolderSQL = `
SELECT p.id::text, p.name
  FROM network.config c
  JOIN network.panel p ON p.id = c."panelId"
 WHERE c."panelId" <> $1::uuid
   AND (c."claimTag" = ANY($2::text[]) OR c.uuid = ANY($3::text[]))
 ORDER BY p.id
 LIMIT 1`

func (s PostgresStore) ClaimHolder(ctx context.Context, panelID string, tags, uuids []string) (Holder, bool, error) {
	rows, err := s.DB.Query(ctx, claimHolderSQL, panelID, nonNil(tags), nonNil(uuids))
	if err != nil {
		return Holder{}, false, fmt.Errorf("reading claim holders for panel %s: %w", panelID, err)
	}
	defer rows.Close()
	var h Holder
	found := rows.Next()
	if found {
		if err := rows.Scan(&h.PanelID, &h.Name); err != nil {
			return Holder{}, false, fmt.Errorf("reading claim holders for panel %s: %w", panelID, err)
		}
	}
	return h, found, rows.Err()
}

// registeredSQL is every pull panel in service but $1, with the inbounds it
// was last read with — the suspects a new panel is compared against.
const registeredSQL = `
SELECT p.id::text, p."driverType"::text, p.transport::text, p."counterSemantics"::text,
       p."apiBaseUrl", coalesce(p."clientBaseUrl", ''), p."panelApiCredentials",
       p.name, coalesce(p."ipAddress", ''),
       coalesce(array_agg(i."remoteId" ORDER BY i."remoteId") FILTER (WHERE i."remoteId" IS NOT NULL), '{}'),
       coalesce(array_agg(i.port ORDER BY i."remoteId") FILTER (WHERE i."remoteId" IS NOT NULL), '{}'),
       coalesce(array_agg(coalesce(i.protocol::text, '')) FILTER (WHERE i."remoteId" IS NOT NULL), '{}')
  FROM network.panel p
  LEFT JOIN network.panel_inbound i ON i."panelId" = p.id AND i."goneAt" IS NULL
 WHERE p.id <> $1::uuid
   AND p.transport = 'pull' AND p."apiBaseUrl" IS NOT NULL
   AND p."reviewState" IN ('accepted', 'accepted_low_trust')
   AND p."retiredAt" IS NULL
 GROUP BY p.id
 ORDER BY p.id`

func (s PostgresStore) Registered(ctx context.Context, panelID string) ([]Registered, error) {
	rows, err := s.DB.Query(ctx, registeredSQL, panelID)
	if err != nil {
		return nil, fmt.Errorf("reading registered panels: %w", err)
	}
	defer rows.Close()
	var out []Registered
	for rows.Next() {
		var r Registered
		var family, transport, semantics string
		var ids, protocols []string
		var ports []int32
		if err := rows.Scan(&r.PanelID, &family, &transport, &semantics,
			&r.APIBaseURL, &r.ClientBaseURL, &r.Credentials, &r.Name, &r.IPAddress,
			&ids, &ports, &protocols); err != nil {
			return nil, fmt.Errorf("reading registered panels: %w", err)
		}
		r.DriverType = driver.DriverType(family)
		r.Transport = driver.Transport(transport)
		r.CounterSemantics = driver.CounterSemantics(semantics)
		for i := range ids {
			r.Inbounds = append(r.Inbounds, InboundKey{RemoteID: ids[i], Port: int(ports[i]), Protocol: protocols[i]})
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

var duplicateSQL = `
WITH tested AS (
UPDATE network.panel
   SET capabilities = $2::jsonb,
       "reviewState" = 'refused',
       "duplicateOfPanelId" = $3::uuid,
       "connectionTestedAt" = $4,
       "connectionTestFault" = NULL,
       "connectionTestDetail" = NULL
 WHERE id = $1::uuid AND "reviewState" = 'pending'` + testedAddressSQL + `
RETURNING id, name, "tenantId", "reviewState", "connectionTestFault")` + fmt.Sprintf(announceSQL, 7)

// Duplicate refuses the panel as one already registered, naming it, under
// Answer's guard and announced the same way.
func (s PostgresStore) Duplicate(ctx context.Context, p Pending, caps driver.Capabilities, holder Holder, at time.Time) (bool, error) {
	doc, err := json.Marshal(caps)
	if err != nil {
		return false, fmt.Errorf("encoding capabilities: %w", err)
	}
	tag, err := s.DB.Exec(ctx, duplicateSQL, p.PanelID, doc, holder.PanelID, at,
		p.APIBaseURL, p.ClientBaseURL, PanelTestedEvent)
	if err != nil {
		return false, fmt.Errorf("writing panel %s duplicate verdict: %w", p.PanelID, err)
	}
	return tag.RowsAffected() == 1, nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
