package register

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/driver"
)

// The statements themselves were run against the real schema (F-027-ax, a
// rolled-back transaction on the dev database). What this pins is what the
// Go side does around them: the pending guard is in every write, a write
// that touched no row is a stale answer, and a fault's detail is bounded.

type row []any

type fakeRows struct {
	rows []row
	at   int
}

func (f *fakeRows) Next() bool { f.at++; return f.at <= len(f.rows) }
func (f *fakeRows) Err() error { return nil }
func (f *fakeRows) Close()     {}
func (f *fakeRows) Scan(dest ...any) error {
	for i, v := range f.rows[f.at-1] {
		switch d := dest[i].(type) {
		case *string:
			*d = v.(string)
		case **time.Time:
			if v != nil {
				t := v.(time.Time)
				*d = &t
			}
		}
	}
	return nil
}

type fakeDB struct {
	rows     []row
	affected string
	sql      []string
	args     [][]any
}

func (f *fakeDB) Query(_ context.Context, sql string, args ...any) (db.Rows, error) {
	f.sql, f.args = append(f.sql, sql), append(f.args, args)
	return &fakeRows{rows: f.rows}, nil
}

func (f *fakeDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.sql, f.args = append(f.sql, sql), append(f.args, args)
	return pgconn.NewCommandTag(f.affected), nil
}

const panel = "55555555-5555-4555-8555-555555555555"

// tested is the declaration a write carries: the addresses its test reached.
var tested = Pending{PanelID: panel, APIBaseURL: "https://p.example/adm1n", ClientBaseURL: ""}

func TestPendingReadsTheRowAsTheRegistrarNeedsIt(t *testing.T) {
	tested := time.Date(2026, 9, 24, 8, 0, 0, 0, time.UTC)
	f := &fakeDB{rows: []row{
		{panel, "hiddify", "pull", "cumulative", "https://p.example/adm1n", "https://cdn.example/cl1ent", "vault:t:panel_credentials:panel:" + panel, tested, "blocked"},
		{"66666666-6666-4666-8666-666666666666", "ibsng", "push", "session", "", "", "vault:t:x", nil, ""},
	}}
	got, err := PostgresStore{DB: f}.Pending(context.Background())
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if !strings.Contains(f.sql[0], `"reviewState" = 'pending'`) {
		t.Error("the read is not limited to pending panels")
	}
	if len(got) != 2 {
		t.Fatalf("got %d candidates, want 2", len(got))
	}
	first := got[0]
	if first.DriverType != driver.DriverHiddify || first.Transport != driver.TransportPull ||
		first.CounterSemantics != driver.CounterCumulative || first.APIBaseURL != "https://p.example/adm1n" ||
		first.ClientBaseURL != "https://cdn.example/cl1ent" {
		t.Errorf("declaration read as %+v", first.Pending)
	}
	if !first.TestedAt.Equal(tested) || first.Fault != FaultKind(driver.FaultBlocked) {
		t.Errorf("last test read as %s / %q: the cool-off after a block is timed from it", first.TestedAt, first.Fault)
	}
	if !got[1].TestedAt.IsZero() || got[1].Fault != "" {
		t.Errorf("a never-tested panel read as tested %s / %q, so it would wait instead of being tested", got[1].TestedAt, got[1].Fault)
	}
}

func TestAVerdictOverAPanelNoLongerPendingIsStale(t *testing.T) {
	f := &fakeDB{affected: "UPDATE 0"}
	caps := driver.Capabilities{Version: driver.CapabilitiesVersion, Answers: map[driver.RowKey]driver.Answer{}}
	written, err := PostgresStore{DB: f}.Answer(context.Background(), tested, caps, driver.ReviewAccepted, time.Now())
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if written {
		t.Error("an update that touched no row reported the verdict written")
	}
	if !strings.Contains(f.sql[0], `AND "reviewState" = 'pending'`) {
		t.Error("the verdict write is not guarded by pending in its own statement (rule 3)")
	}

	f.affected = "UPDATE 1"
	if written, _ := (PostgresStore{DB: f}).Answer(context.Background(), tested, caps, driver.ReviewAccepted, time.Now()); !written {
		t.Error("an update of one row did not report the verdict written")
	}
}

func TestAFaultIsGuardedAndItsDetailBounded(t *testing.T) {
	f := &fakeDB{affected: "UPDATE 1"}
	detail := strings.Repeat("ж", maxDetail) // two bytes each: the cut lands mid-rune
	if _, err := (PostgresStore{DB: f}).Fail(context.Background(), tested, FaultUnopenable, detail, time.Now()); err != nil {
		t.Fatalf("Fail: %v", err)
	}
	if !strings.Contains(f.sql[0], `AND "reviewState" = 'pending'`) {
		t.Error("the fault write is not guarded by pending (rule 5)")
	}
	stored := f.args[0][2].(string)
	if len(stored) > maxDetail {
		t.Errorf("detail stored at %d bytes, over the %d bound", len(stored), maxDetail)
	}
	if !strings.HasPrefix(detail, stored) || !strings.HasSuffix(stored, "ж") {
		t.Error("the bounded detail is not a whole-rune prefix of the original")
	}
}

// F-027-cc: an edit that changes an address sends the panel back to pending,
// so pending alone does not tell the old server's answer from the new one's.
// Both writes name the addresses tested, and a changed one touches no row.
func TestAnAnswerIsGuardedByTheAddressItTested(t *testing.T) {
	f := &fakeDB{affected: "UPDATE 0"}
	caps := driver.Capabilities{Version: driver.CapabilitiesVersion, Answers: map[driver.RowKey]driver.Answer{}}
	written, err := PostgresStore{DB: f}.Answer(context.Background(), tested, caps, driver.ReviewAccepted, time.Now())
	if err != nil || written {
		t.Fatalf("Answer: written=%v err=%v; an update that touched no row is stale", written, err)
	}
	failed, err := PostgresStore{DB: f}.Fail(context.Background(), tested, FaultUnopenable, "x", time.Now())
	if err != nil || failed {
		t.Fatalf("Fail: written=%v err=%v; an update that touched no row is stale", failed, err)
	}
	for i, write := range []string{"verdict", "fault"} {
		if !strings.Contains(f.sql[i], `coalesce("apiBaseUrl", '') = $5 AND coalesce("clientBaseUrl", '') = $6`) {
			t.Errorf("the %s write is not guarded by the addresses it tested", write)
		}
		if f.args[i][4] != tested.APIBaseURL || f.args[i][5] != tested.ClientBaseURL {
			t.Errorf("the %s write carries addresses %v / %v, want the tested ones", write, f.args[i][4], f.args[i][5])
		}
	}
}

// F-027-bs: every test result is announced through the outbox, in the same
// statement as the write it announces — never a publish after it.
func TestEveryTestResultIsAnnouncedInItsOwnStatement(t *testing.T) {
	f := &fakeDB{affected: "INSERT 0 1"}
	caps := driver.Capabilities{Version: driver.CapabilitiesVersion, Answers: map[driver.RowKey]driver.Answer{}}
	written, err := PostgresStore{DB: f}.Answer(context.Background(), tested, caps, driver.ReviewRefused, time.Now())
	if err != nil || !written {
		t.Fatalf("Answer: written=%v err=%v", written, err)
	}
	if _, err := (PostgresStore{DB: f}).Fail(context.Background(), tested, FaultUnopenable, "no driver", time.Now()); err != nil {
		t.Fatalf("Fail: %v", err)
	}
	for i, write := range []string{"verdict", "fault"} {
		sql := f.sql[i]
		if !strings.Contains(sql, "INSERT INTO automation.outbox_event") || !strings.Contains(sql, "RETURNING") {
			t.Errorf("the %s write does not insert its outbox event in the same statement", write)
		}
		if !strings.Contains(sql, "'platform_owner'") {
			t.Errorf("the %s event does not name the platform owner for a platform panel, whose tenantId is null", write)
		}
		// F-067-o: the owner is told in their inbox and bot, so the event names
		// them and the panel — the consumer never resolves either.
		if !strings.Contains(sql, "'ownerUserId'") || !strings.Contains(sql, "'panelName'") {
			t.Errorf("the %s event does not name the tenant's owner and the panel", write)
		}
		if f.args[i][len(f.args[i])-1] != PanelTestedEvent {
			t.Errorf("the %s event is typed %v, want %q", write, f.args[i][len(f.args[i])-1], PanelTestedEvent)
		}
	}
}

// The type is the routing key the worker binds and the `type` the panel
// filters on; both read it from contracts/realtime/events.json (C-08).
func TestThePanelTestedTypeIsTheDeclaredRealtimeEvent(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean("../../../contracts/realtime/events.json"))
	if err != nil {
		t.Fatalf("reading the fixture: %v", err)
	}
	var doc struct {
		RealtimeEvents map[string]string `json:"realtimeEvents"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parsing the fixture: %v", err)
	}
	if got := doc.RealtimeEvents["panelTested"]; got != PanelTestedEvent {
		t.Errorf("events.json panelTested = %q, register.PanelTestedEvent = %q", got, PanelTestedEvent)
	}
}
