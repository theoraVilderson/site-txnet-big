package hot_test

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/collect"
	"network-service/internal/db"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/hot"
)

// The candidate statement was run against the real schema (F-027-bu, a
// rolled-back transaction on the dev database). What this pins is what the Go
// side does around it: a candidate rides a panel the bulk pass already
// opened, with the configs the statement returned rather than the bulk
// pass's copy, and its cursor is the statement's, not a stale one.

type pgRow []any

type pgRows struct {
	rows []pgRow
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
		case *bool:
			*d = v.(bool)
		case *int:
			*d = v.(int)
		case *int64:
			*d = v.(int64)
		case **time.Time:
			if v != nil {
				t := v.(time.Time)
				*d = &t
			}
		}
	}
	return nil
}

type pgDB struct {
	rows []pgRow
	sql  []string
	args [][]any
}

func (f *pgDB) Query(_ context.Context, sql string, args ...any) (db.Rows, error) {
	f.sql, f.args = append(f.sql, sql), append(f.args, args)
	return &pgRows{rows: f.rows}, nil
}

func (f *pgDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.sql, f.args = append(f.sql, sql), append(f.args, args)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

type offered []collect.Panel

func (o offered) Offered() []collect.Panel { return o }

const (
	hotPanel  = "11111111-1111-4111-8111-111111111111"
	hotConfig = "77777777-7777-4777-8777-777777777777"
)

// candidateRow is one row as the candidate statement selects it: the config,
// its share and rate, and its cursor.
func candidateRow(panelID, configID, remoteID string, allocated, rate, lifetime int64, observed any) pgRow {
	return pgRow{panelID, configID, remoteID, "vless", allocated, rate,
		observed != nil, "cumulative", lifetime, lifetime, lifetime, lifetime, observed, 0, nil}
}

func TestCandidatesRideTheOfferedPanelWithTheirOwnConfigsAndCursors(t *testing.T) {
	observed := time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)
	p := fake.New(fake.Config{})
	panel := collect.Panel{ID: hotPanel, CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull,
		MaxLineRateBps: gigabit, Driver: p, Configs: map[string]collect.ConfigRef{}}
	pool := &pgDB{rows: []pgRow{candidateRow(hotPanel, hotConfig, "r-new", 1000, 8_000, 300, observed)}}
	cursors := &collect.PostgresCursors{DB: pool}
	source := &hot.PostgresSource{DB: pool, Panels: offered{panel}, Cursors: cursors}

	cands, err := source.Candidates(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 1 {
		t.Fatalf("candidates = %d; want 1", len(cands))
	}
	c := cands[0]
	// Headroom is the share less what the cursor says was served (up + down).
	if c.ConfigID != hotConfig || c.RemoteID != "r-new" || c.HeadroomBytes != 400 || c.RateBps != 8_000 {
		t.Fatalf("candidate = %+v", c)
	}
	// The bulk pass's copy of the panel did not know this client yet; the
	// candidate's does, so its bytes are billed rather than unattributed.
	if ref := c.Panel.Configs["r-new"]; ref.ConfigID != hotConfig {
		t.Fatalf("candidate panel configs = %+v", c.Panel.Configs)
	}
	if len(panel.Configs) != 0 {
		t.Fatal("the bulk pass's panel was written to")
	}
	if c.Panel.Driver != panel.Driver {
		t.Fatal("the candidate was given a driver other than the bulk pass's — two budgets on one panel")
	}
	// Its cursor is the statement's, so a client re-keyed since the last
	// bulk pass is not adopted again from zero.
	cur, seen := cursors.Counter(hotPanel, "r-new")
	if !seen || cur.LifetimeUpBytes != 300 || !cur.LastObservedAt.Equal(observed) {
		t.Fatalf("cursor = %+v, seen %v", cur, seen)
	}
	if got := pool.args[0][0].([]string); len(got) != 1 || got[0] != hotPanel {
		t.Fatalf("queried panels = %v", got)
	}
}

func TestNoOfferedPanelIsNoQuery(t *testing.T) {
	pool := &pgDB{}
	source := &hot.PostgresSource{DB: pool, Panels: offered{}, Cursors: &collect.PostgresCursors{DB: pool}}
	cands, err := source.Candidates(context.Background())
	if err != nil || len(cands) != 0 || len(pool.sql) != 0 {
		t.Fatalf("candidates = %v, err %v, queries %d", cands, err, len(pool.sql))
	}
}

// Two loops, one cursor: a hot turn that ran while the bulk pass held the
// panel would compute its delta from the cursor the bulk turn is about to
// move, and the same bytes would be published twice under two delta ids —
// which `usage_delta_seen` cannot absorb. The hot turn steps aside instead;
// the bulk read covers every client, the hot ones included.
func TestHotTurnStepsAsideWhileTheBulkTurnHoldsThePanel(t *testing.T) {
	r := newRig(t, "c1")
	r.hot("c1", gigabit, 10)
	turns := &collect.TurnLocks{}
	r.loop.Turns = turns

	release := turns.Hold("panel-1")
	report := r.pass(t)
	release()

	if r.sink.calls != 0 {
		t.Fatalf("published %d times while the bulk turn held the panel", r.sink.calls)
	}
	if report.Busy != 1 || len(report.Failed) != 0 {
		t.Fatalf("busy = %d, failed = %v; a panel the bulk pass is reading is not a failure", report.Busy, report.Failed)
	}

	r.pass(t)
	if r.sink.calls != 1 {
		t.Fatalf("published %d times once the panel was free; want 1", r.sink.calls)
	}
}
