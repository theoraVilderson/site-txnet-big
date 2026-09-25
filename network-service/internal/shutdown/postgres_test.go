package shutdown_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/collect"
	"network-service/internal/db"
	"network-service/internal/shutdown"
)

// The statement was run against the real schema (F-027-bv, a rolled-back
// transaction on the dev database). What this pins is what the Go side does
// around it, and that the extension never writes a panel whose turn a loop
// still holds.

type pgRows struct {
	rows [][]any
	at   int
}

func (f *pgRows) Next() bool { f.at++; return f.at <= len(f.rows) }
func (f *pgRows) Err() error { return nil }
func (f *pgRows) Close()     {}
func (f *pgRows) Scan(dest ...any) error {
	for i, v := range f.rows[f.at-1] {
		switch d := dest[i].(type) {
		case *string:
			*d = v.(string)
		case *int64:
			*d = v.(int64)
		}
	}
	return nil
}

type pgDB struct {
	rows [][]any
	args [][]any
}

func (f *pgDB) Query(_ context.Context, _ string, args ...any) (db.Rows, error) {
	f.args = append(f.args, args)
	return &pgRows{rows: f.rows}, nil
}

func (f *pgDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("UPDATE 0"), nil
}

func TestPostgresReservesReadTheFiguresBillingLeftOnTheConfig(t *testing.T) {
	pool := &pgDB{rows: [][]any{{"config-c1", "c1", int64(2 * gb), int64(7 * gb)}}}
	got, err := (shutdown.PostgresReserves{DB: pool}).Extensions(context.Background(), "panel-1")
	if err != nil {
		t.Fatal(err)
	}
	want := shutdown.Extension{ConfigID: "config-c1", RemoteID: "c1", AllocatedBytes: 2 * gb, WalletBackedBytes: 7 * gb}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("extensions = %+v; want %+v", got, want)
	}
	if pool.args[0][0] != "panel-1" {
		t.Fatalf("queried panel = %v", pool.args[0][0])
	}
}

// Shutdown cancels the loops, but a turn already inside its publish or its
// convergence finishes first. An extension written under it could be pulled
// straight back down as `above_allocation` by that turn's ceiling pass, so the
// extension waits for the panel's turn like any other writer.
func TestExtensionWaitsForTheTurnALoopStillHolds(t *testing.T) {
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.reserve("panel-1", "c1", 2*gb, 7*gb)
	turns := &collect.TurnLocks{}
	r.extender.Turns = turns

	release := turns.Hold("panel-1")
	done := make(chan shutdown.Report)
	go func() { done <- r.run(t) }()

	select {
	case <-done:
		t.Fatal("the extension ran while a loop held the panel's turn")
	case <-time.After(50 * time.Millisecond):
	}
	release()
	report := <-done
	if report.Raised != 1 {
		t.Fatalf("raised = %d once the turn was released; want 1", report.Raised)
	}
}
