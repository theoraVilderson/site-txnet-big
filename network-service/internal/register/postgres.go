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
       "connectionTestedAt", coalesce("connectionTestFault"::text, '')
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
			&c.APIBaseURL, &c.ClientBaseURL, &c.Credentials, &testedAt, &fault); err != nil {
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
