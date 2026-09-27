package leaseplan_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/leaseplan"
)

type recDB struct {
	sql  []string
	args [][]any
}

func (r *recDB) Query(context.Context, string, ...any) (db.Rows, error) { return nil, nil }

func (r *recDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	r.sql, r.args = append(r.sql, sql), append(r.args, args)
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

// F-027-dw (ADR-0096): a close is announced in the statement that writes it
// (ADR-0021), so billing turns a prepaid Grant `suspended` the moment its
// configs go off, and never for a close that did not commit. A reopen is
// silent: only a renewal reopens, and the renewal revived the Grant itself.
func TestAClosureIsAnnouncedInTheStatementThatWritesIt(t *testing.T) {
	r := &recDB{}
	s := leaseplan.PostgresStore{DB: r}
	c := &leaseplan.Closure{Quota: 1 << 30, ExpiresAt: time.Date(2026, 9, 28, 9, 42, 58, 0, time.UTC)}
	if err := s.SaveClosure(context.Background(), "grant-1", c); err != nil {
		t.Fatalf("SaveClosure: %v", err)
	}
	for _, part := range []string{"INSERT INTO network.lease_close", "RETURNING", "INSERT INTO automation.outbox_event", `'grantId'`, `'userId'`, `'quotaBytes'`} {
		if !strings.Contains(r.sql[0], part) {
			t.Errorf("the close's announcement is missing %q", part)
		}
	}
	// ADR-0094 lists the foreign columns this service may read; tenantId is not one.
	if strings.Contains(r.sql[0], `"tenantId"`) {
		t.Error("the close reads entitlement.grant.tenantId, which ADR-0094 does not list")
	}
	if got := r.args[0][3]; got != leaseplan.ClosedEvent {
		t.Errorf("announced as %v, want %s", got, leaseplan.ClosedEvent)
	}
	if err := s.SaveClosure(context.Background(), "grant-1", nil); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if strings.Contains(r.sql[1], "outbox_event") {
		t.Error("a reopen announced something")
	}
}
