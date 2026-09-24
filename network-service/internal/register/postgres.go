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
// Both writes carry `"reviewState" = 'pending'` in their WHERE, so the rule
// that a verdict lands only over pending (contract.registration.md rule 3)
// is the database's to hold, in the same statement, not a read before it.
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

const answerSQL = `
UPDATE network.panel
   SET capabilities = $2::jsonb,
       "reviewState" = $3::network."PanelReviewState",
       "connectionTestedAt" = $4,
       "connectionTestFault" = NULL,
       "connectionTestDetail" = NULL
 WHERE id = $1::uuid AND "reviewState" = 'pending'`

// Answer writes the verdict. false is a panel no longer pending — withdrawn
// or already answered — and the answer is dropped (rule 3).
func (s PostgresStore) Answer(ctx context.Context, panelID string, caps driver.Capabilities, state driver.ReviewState, at time.Time) (bool, error) {
	doc, err := json.Marshal(caps)
	if err != nil {
		return false, fmt.Errorf("encoding capabilities: %w", err)
	}
	tag, err := s.DB.Exec(ctx, answerSQL, panelID, doc, string(state), at)
	if err != nil {
		return false, fmt.Errorf("writing panel %s verdict: %w", panelID, err)
	}
	return tag.RowsAffected() == 1, nil
}

const failSQL = `
UPDATE network.panel
   SET "connectionTestedAt" = $4,
       "connectionTestFault" = $2::network."ConnectionTestFault",
       "connectionTestDetail" = $3
 WHERE id = $1::uuid AND "reviewState" = 'pending'`

// Fail records a test that produced no verdict. A panel no longer pending is
// left as it is: a fault lives only on a pending panel (rule 5).
func (s PostgresStore) Fail(ctx context.Context, panelID string, fault FaultKind, detail string, at time.Time) error {
	if _, err := s.DB.Exec(ctx, failSQL, panelID, string(fault), truncate(detail, maxDetail), at); err != nil {
		return fmt.Errorf("writing panel %s fault: %w", panelID, err)
	}
	return nil
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
