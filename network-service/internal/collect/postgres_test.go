package collect_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/collect"
	"network-service/internal/db"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/panelstate"
	"network-service/internal/register"
)

// The statements themselves were run against the real schema (F-027-bt, a
// rolled-back transaction on the dev database). What this pins is what the Go
// side does around them: which panels a pass is offered and with what
// driver, that a cursor is read and written by config, and that a panel
// banned before a restart stays banned after it.

// ---- a scripted pool -------------------------------------------------------

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

// pgDB answers a query by the first key its SQL contains, so a pass that runs
// two statements gets each its own rows.
type pgDB struct {
	answers map[string][]pgRow
	sql     []string
	args    [][]any
}

func (f *pgDB) Query(_ context.Context, sql string, args ...any) (db.Rows, error) {
	f.sql, f.args = append(f.sql, sql), append(f.args, args)
	for key, rows := range f.answers {
		if strings.Contains(sql, key) {
			return &pgRows{rows: rows}, nil
		}
	}
	return &pgRows{}, nil
}

func (f *pgDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.sql, f.args = append(f.sql, sql), append(f.args, args)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

// executed is the args of every statement whose SQL contains key.
func (f *pgDB) executed(key string) [][]any {
	var out [][]any
	for i, sql := range f.sql {
		if strings.Contains(sql, key) {
			out = append(out, f.args[i])
		}
	}
	return out
}

const (
	pgPanelA  = "11111111-1111-4111-8111-111111111111"
	pgPanelB  = "22222222-2222-4222-8222-222222222222"
	pgConfig1 = "77777777-7777-4777-8777-777777777777"
	pgTenant  = "99999999-9999-4999-8999-999999999999"
)

// panelRow is one `network.panel` row as panelsSQL selects it.
func panelRow(id, login string, perMinute int, state string, blockedSince any) pgRow {
	return pgRow{id, "marzban", "cumulative", "https://" + id + ".example", "", login,
		"accepted", "tenant", pgTenant, int64(0), perMinute, state, blockedSince}
}

// configRow is one `network.config` row joined to its cursor, as the cursor
// load selects it. A nil observed time is a config with no cursor yet.
func configRow(panelID, configID, remoteID string, last, lifetime int64, observed any) pgRow {
	has := observed != nil
	return pgRow{panelID, configID, remoteID, "vless", has, "cumulative",
		last, last, lifetime, lifetime, observed, 2, nil}
}

// countingOpener is the vault-and-driver side, counted: every Open is a login
// read through tenant-service, which is what the cache exists to spare.
type countingOpener struct {
	opened []register.Pending
	fail   map[string]error
}

func (o *countingOpener) Open(_ context.Context, p register.Pending) (driver.Driver, error) {
	o.opened = append(o.opened, p)
	if err := o.fail[p.PanelID]; err != nil {
		return nil, err
	}
	return fake.New(fake.Config{}).Driver(), nil
}

type restored struct{ byPanel map[string]panelstate.Record }

func (r *restored) Restore(panelID string, rec panelstate.Record) { r.byPanel[panelID] = rec }

// ---- the source ------------------------------------------------------------

func TestSourceOffersEachPanelWithItsConfigsAndOpensItsDriverOnce(t *testing.T) {
	observed := time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)
	pool := &pgDB{answers: map[string][]pgRow{
		`FROM network.panel`:  {panelRow(pgPanelA, "vault:a", 60, "healthy", nil)},
		`FROM network.config`: {configRow(pgPanelA, pgConfig1, "r1", 500, 900, observed)},
	}}
	opener := &countingOpener{}
	cursors := &collect.PostgresCursors{DB: pool}
	source := &collect.PostgresSource{DB: pool, Opener: opener, Cursors: cursors}

	first, err := source.Panels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := source.Panels(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("panels offered = %d, %d; want 1 each", len(first), len(second))
	}
	p := first[0]
	if p.ID != pgPanelA || p.OwnershipType != "tenant" || p.TenantID != pgTenant || p.MaxRequestsPerMinute != 60 {
		t.Fatalf("panel = %+v", p)
	}
	if !p.ReviewState.Collectable() || p.CounterSemantics != driver.CounterCumulative {
		t.Fatalf("declaration = %s / %s", p.ReviewState, p.CounterSemantics)
	}
	if ref := p.Configs["r1"]; ref.ConfigID != pgConfig1 || ref.Protocol != "vless" {
		t.Fatalf("config r1 = %+v", ref)
	}
	// One login read for two passes, and the same paced driver both times: a
	// fresh pace every pass is a budget that never remembers the last one.
	if len(opener.opened) != 1 {
		t.Fatalf("opened %d times over two passes; want 1", len(opener.opened))
	}
	if second[0].Driver != p.Driver {
		t.Fatal("the second pass was given a different driver")
	}
	// The cursor is the row's, found by the client id the pass reads with.
	cur, seen := cursors.Counter(pgPanelA, "r1")
	if !seen || cur.LastUpBytes != 500 || cur.LifetimeDownBytes != 900 || !cur.LastObservedAt.Equal(observed) || cur.ResetCount != 2 {
		t.Fatalf("cursor = %+v, seen %v", cur, seen)
	}
}

func TestSourceReopensAPanelWhoseRowChangedAndSkipsOneItCannotOpen(t *testing.T) {
	pool := &pgDB{answers: map[string][]pgRow{
		`FROM network.panel`: {panelRow(pgPanelA, "vault:a", 60, "healthy", nil), panelRow(pgPanelB, "vault:b", 60, "healthy", nil)},
	}}
	opener := &countingOpener{fail: map[string]error{pgPanelB: errors.New("vault refused the login read")}}
	source := &collect.PostgresSource{DB: pool, Opener: opener, Cursors: &collect.PostgresCursors{DB: pool}}

	panels, err := source.Panels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// One panel the vault will not open is not a pass that stops: it is left
	// out, never stamped, and ages into the watchdog's alert.
	if len(panels) != 1 || panels[0].ID != pgPanelA {
		t.Fatalf("panels = %+v; want only %s", panels, pgPanelA)
	}

	// The owner lowered the budget: the row changed, so the driver is rebuilt
	// under the new figure rather than kept under the old one.
	pool.answers[`FROM network.panel`] = []pgRow{panelRow(pgPanelA, "vault:a", 30, "healthy", nil)}
	opener.fail = nil
	panels, err = source.Panels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(panels) != 1 || panels[0].MaxRequestsPerMinute != 30 {
		t.Fatalf("panels = %+v", panels)
	}
	// A: opened, then reopened. B: tried once and not cached.
	if len(opener.opened) != 3 {
		t.Fatalf("opened %d times; want 3", len(opener.opened))
	}
}

func TestSourceRestoresABanTheDatabaseAlreadyHolds(t *testing.T) {
	blocked := time.Date(2026, 9, 25, 8, 55, 0, 0, time.UTC)
	pool := &pgDB{answers: map[string][]pgRow{
		`FROM network.panel`: {panelRow(pgPanelA, "vault:a", 60, "throttled_or_blocked", blocked)},
	}}
	states := &restored{byPanel: map[string]panelstate.Record{}}
	source := &collect.PostgresSource{DB: pool, Opener: &countingOpener{}, Cursors: &collect.PostgresCursors{DB: pool}, States: states}

	if _, err := source.Panels(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := states.byPanel[pgPanelA]
	if got.State != panelstate.ThrottledOrBlocked || !got.BlockedSince.Equal(blocked) {
		t.Fatalf("restored = %+v", got)
	}
}

// A ban written before a restart holds after it: the tracker is told what the
// row says, and the panel is not asked until the cool-off from that clock has
// run — not from the moment the process came back.
func TestTrackerRestoredFromARowKeepsTheBan(t *testing.T) {
	blocked := time.Date(2026, 9, 25, 8, 55, 0, 0, time.UTC)
	tracker := &panelstate.Tracker{}
	tracker.Restore(pgPanelA, panelstate.Record{State: panelstate.ThrottledOrBlocked, BlockedSince: blocked})

	if tracker.Ask(pgPanelA, blocked.Add(time.Minute)) {
		t.Fatal("a restored ban was asked inside its cool-off")
	}
	if !tracker.Ask(pgPanelA, blocked.Add(panelstate.DefaultCooloff)) {
		t.Fatal("a restored ban was not lifted when its cool-off ran")
	}

	// What this process observed itself outranks the row it started from.
	tracker.Observe(context.Background(), pgPanelB, nil, blocked)
	tracker.Restore(pgPanelB, panelstate.Record{State: panelstate.Down})
	if got := tracker.State(pgPanelB); got.State != panelstate.Healthy {
		t.Fatalf("restore overwrote an observed state: %+v", got)
	}
}

// ---- the cursors -----------------------------------------------------------

func TestCursorsAreWrittenByConfigAndReadBackWithoutAQuery(t *testing.T) {
	at := time.Date(2026, 9, 25, 9, 1, 0, 0, time.UTC)
	pool := &pgDB{}
	cursors := &collect.PostgresCursors{DB: pool}

	res := collect.Result{PanelID: pgPanelA, ObservedAt: at, Advances: []collect.Advance{{
		PanelID: pgPanelA, ConfigID: pgConfig1, RemoteID: "r1",
		Counter: collect.Counter{Semantics: driver.CounterCumulative, LastUpBytes: 10, LastDownBytes: 20,
			LifetimeUpBytes: 110, LifetimeDownBytes: 220, LastObservedAt: at},
	}}}
	if err := cursors.Apply(context.Background(), res); err != nil {
		t.Fatal(err)
	}

	upserts := pool.executed(`INSERT INTO network.config_counter_state`)
	if len(upserts) != 1 {
		t.Fatalf("upserts = %d; want 1 statement for the whole pass", len(upserts))
	}
	if ids := upserts[0][0].([]string); len(ids) != 1 || ids[0] != pgConfig1 {
		t.Fatalf("upserted config ids = %v", ids)
	}
	// Write-through: the ceiling pass that runs next reads the moved cursor.
	cur, seen := cursors.Counter(pgPanelA, "r1")
	if !seen || cur.LifetimeDownBytes != 220 {
		t.Fatalf("cursor after apply = %+v, seen %v", cur, seen)
	}
}

func TestCursorsRefuseWhatTheyCannotStore(t *testing.T) {
	at := time.Date(2026, 9, 25, 9, 1, 0, 0, time.UTC)
	cases := map[string]collect.Advance{
		// A session high-water is `radius_session`'s, and the pull source
		// never offers a session panel. Dropping the mark would re-bill.
		"session mark": {PanelID: pgPanelA, ConfigID: pgConfig1, RemoteID: "r1", SessionID: "s1",
			Counter: collect.Counter{Semantics: driver.CounterSession}, Session: &collect.SessionMark{}},
		"no config": {PanelID: pgPanelA, RemoteID: "r1", Counter: collect.Counter{Semantics: driver.CounterCumulative}},
	}
	for name, adv := range cases {
		t.Run(name, func(t *testing.T) {
			pool := &pgDB{}
			cursors := &collect.PostgresCursors{DB: pool}
			err := cursors.Apply(context.Background(), collect.Result{PanelID: pgPanelA, ObservedAt: at, Advances: []collect.Advance{adv}})
			if err == nil {
				t.Fatal("Apply accepted an advance it cannot store")
			}
			if len(pool.sql) != 0 {
				t.Fatal("a refused pass still wrote")
			}
		})
	}
}

// The normaliser names the config on every advance, so the cursor it moves is
// the row's and not whatever client id the panel uses this week.
func TestNormaliserNamesTheConfigOnEveryAdvance(t *testing.T) {
	p := fake.New(fake.Config{})
	p.Given("r1")
	readings, _ := p.GetUsage(context.Background())
	res := collect.Normaliser{
		Panel:   collect.Panel{ID: pgPanelA, CounterSemantics: driver.CounterCumulative, Configs: map[string]collect.ConfigRef{"r1": {ConfigID: pgConfig1}}},
		Cursors: collect.NewMemoryCursors(),
	}.Pass(readings, time.Now())
	if len(res.Advances) != 1 || res.Advances[0].ConfigID != pgConfig1 {
		t.Fatalf("advances = %+v", res.Advances)
	}
}

// ---- progress, rates, drift events ------------------------------------------

func TestPassSideWritesAreOneStatementEach(t *testing.T) {
	at := time.Date(2026, 9, 25, 9, 1, 0, 0, time.UTC)
	pool := &pgDB{answers: map[string][]pgRow{`FROM network.panel_drift_event`: {{true}}}}
	ctx := context.Background()

	if err := (collect.PostgresProgress{DB: pool}).Collected(ctx, []collect.PanelProgress{{PanelID: pgPanelA, At: at}, {PanelID: pgPanelB, At: at}}); err != nil {
		t.Fatal(err)
	}
	if err := (collect.PostgresRates{DB: pool}).Record(ctx, []collect.RateSample{{ConfigID: pgConfig1, RateBps: 8_000}}); err != nil {
		t.Fatal(err)
	}
	events := collect.PostgresDriftEvents{DB: pool}
	if err := events.Raise(ctx, collect.DriftEvent{PanelID: pgPanelA, Type: collect.MassReset, Affected: 6, Observed: 10, DetectedAt: at, CollectionHalted: true}); err != nil {
		t.Fatal(err)
	}
	halted, err := events.Halted(ctx, pgPanelA)
	if err != nil || !halted {
		t.Fatalf("halted = %v, %v", halted, err)
	}

	if got := pool.executed(`"lastSuccessfulCollectionAt"`); len(got) != 1 || len(got[0][0].([]string)) != 2 {
		t.Fatalf("progress writes = %v", got)
	}
	if got := pool.executed(`"observedRateBps"`); len(got) != 1 || got[0][1].([]int64)[0] != 8_000 {
		t.Fatalf("rate writes = %v", got)
	}
	// Both counts, never the ratio (invariant 23).
	if got := pool.executed(`INSERT INTO network.panel_drift_event`); len(got) != 1 || got[0][2] != 6 || got[0][3] != 10 {
		t.Fatalf("drift event = %v", got)
	}
}
