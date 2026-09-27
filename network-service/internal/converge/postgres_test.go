package converge

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/driver"
)

// The statements themselves were run against the real schema (F-027-bo, a
// rolled-back transaction on the dev database). What this pins is what the
// Go side does around them: which rows a pass is given, that an outcome is
// recorded only over the desired state it was judged against, and that stored
// lines are touched only by a capture.

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
		case **int64:
			if v != nil {
				n := v.(int64)
				*d = &n
			}
		case **time.Time:
			if v != nil {
				t := v.(time.Time)
				*d = &t
			}
		case *[]string:
			*d = v.([]string)
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

const (
	pgPanel  = "55555555-5555-4555-8555-555555555555"
	pgConfig = "77777777-7777-4777-8777-777777777777"
)

func TestDesiredForReadsTheRowAsTheProvisioningPassNeedsIt(t *testing.T) {
	repaired := time.Date(2026, 9, 24, 8, 0, 0, 0, time.UTC)
	captured := time.Date(2026, 9, 24, 9, 0, 0, 0, time.UTC)
	f := &pgDB{rows: []pgRow{
		{pgConfig, "r-1", "txn-abc", "uuid-1", "vless", "7", true, true, int64(5_000), int64(1_200),
			"partial", "renamed", 1, repaired, []string{"vless://a"}, "r-1", "uuid-1", captured, false, false},
		{"88888888-8888-4888-8888-888888888888", "", "txn-def", "uuid-2", "vmess", "", true, true, nil, int64(0),
			"pending", "synced", 0, nil, []string{}, "", "", nil, true, true},
	}}
	got, err := PostgresDesired{DB: f}.For(context.Background(), pgPanel)
	if err != nil {
		t.Fatalf("For: %v", err)
	}
	if f.args[0][0] != pgPanel {
		t.Errorf("read for panel %v, want %s", f.args[0][0], pgPanel)
	}
	// A delete the pass already confirmed is finished for good; a pass that
	// kept reading it would spend a row on every client ever removed.
	if !strings.Contains(f.sql[0], `NOT (c."desiredRemote" = 'absent' AND c."remoteId" IS NULL AND c."enforcementState" = 'complete')`) {
		t.Error("finished deletes are not left out of the pass")
	}
	if len(got) != 2 {
		t.Fatalf("got %d rows, want 2", len(got))
	}
	first := got[0]
	if first.ConfigID != pgConfig || first.RemoteID != "r-1" || first.ClaimTag != "txn-abc" || first.UUID != "uuid-1" ||
		first.Protocol != "vless" || first.InboundRemoteID != "7" || !first.Enabled || !first.Present {
		t.Errorf("identity read wrong: %+v", first)
	}
	if first.AllocatedBytes == nil || *first.AllocatedBytes != 5_000 || first.ServedBytes != 1_200 {
		t.Errorf("allocation read wrong: allocated %v served %d", first.AllocatedBytes, first.ServedBytes)
	}
	if first.State != StatePartial || first.Drift != DriftRenamed || first.RepairCount != 1 || !first.RepairedAt.Equal(repaired) {
		t.Errorf("state read wrong: %+v", first)
	}
	if want := (CapturedLinks{Lines: []string{"vless://a"}, RemoteID: "r-1", UUID: "uuid-1", At: captured}); !sameLinks(first.Links, want) {
		t.Errorf("links read %+v, want %+v", first.Links, want)
	}
	// A row placed before F-114-b takes a picked inbound only: never an unpicked or gone one.
	if !strings.Contains(f.sql[0], `i.sold AND i."goneAt" IS NULL AND i.protocol = c.protocol`) {
		t.Error("a config with no inbound of its own is not held to the panel's picks")
	}
	// F-027-ch: and never one a group holds — that inbound left the pool.
	if !strings.Contains(f.sql[0], `NOT EXISTS (SELECT 1 FROM network.panel_group_member_inbound a`) {
		t.Error("a config with no inbound of its own can be created on an inbound a group holds")
	}
	second := got[1]
	if first.InboundResolved || !second.InboundResolved {
		t.Errorf("resolved read %v, %v; want false, true", first.InboundResolved, second.InboundResolved)
	}
	if second.InboundRemoteID != "" {
		t.Errorf("nothing picked read as inbound %q", second.InboundRemoteID)
	}
	if first.Unlimited || !second.Unlimited {
		t.Errorf("unlimited read %v, %v; want false, true (F-111-r)", first.Unlimited, second.Unlimited)
	}
	if second.AllocatedBytes != nil {
		t.Error("no share yet read as a share: the pass would create a client with no ceiling")
	}
	if !second.Links.At.IsZero() || !second.RepairedAt.IsZero() {
		t.Error("a config never captured or repaired read as one that was")
	}
}

func TestDesiredRecordIsHeldToTheDesiredStateItWasJudgedAgainst(t *testing.T) {
	at := time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)
	f := &pgDB{}
	err := PostgresDesired{DB: f}.Record(context.Background(), []Outcome{
		{ConfigID: pgConfig, RemoteID: "r-9", State: StateComplete, At: at, UUID: "uuid-1", Enabled: true, Present: true, InboundRemoteID: "4"},
		{ConfigID: "88888888-8888-4888-8888-888888888888", State: StateComplete, At: at, UUID: "uuid-2", Present: false,
			Links: &CapturedLinks{RemoteID: "r-2", UUID: "uuid-2", At: at}},
	})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if len(f.sql) != 2 {
		t.Fatalf("got %d statements, want one per outcome", len(f.sql))
	}
	// A regenerate or a disable landing mid-pass changes the row under the
	// verdict. Without the guard a `complete` would be written over a state
	// nobody read — and group fulfilment activates a Grant on `complete`.
	for _, clause := range []string{`uuid = $`, `"desiredEnabled" = $`, `("desiredRemote" = 'present') = $`} {
		if !strings.Contains(f.sql[0], clause) {
			t.Errorf("the record is not held to %q", clause)
		}
	}
	first := f.args[0]
	if first[0] != pgConfig || first[1] != "r-9" || first[2] != "complete" || first[3] != at ||
		first[4] != "uuid-1" || first[5] != true || first[6] != true {
		t.Errorf("first outcome written with %v", first)
	}
	if first[7] != false {
		t.Error("an outcome with no capture overwrote the stored lines")
	}
	// F-027-ch: the inbound a client was found on is written only over none,
	// and never where another row of the Grant already holds it on the panel.
	if first[15] != "4" || !strings.Contains(f.sql[0], `WHEN "inboundRemoteId" IS NULL AND $16 <> ''`) ||
		!strings.Contains(f.sql[0], `o."inboundRemoteId" = $16`) {
		t.Errorf("the learned inbound is not written over none only: arg %v", first[15])
	}
	second := f.args[1]
	if second[1] != "" {
		t.Errorf("a confirmed delete wrote remoteId %v, want it cleared", second[1])
	}
	if second[7] != true {
		t.Fatal("a capture was not written")
	}
	// A panel that gives no lines is an empty array with a time, never NULL:
	// the column is NOT NULL and empty-with-a-time is what says so.
	if lines, ok := second[8].([]string); !ok || lines == nil || len(lines) != 0 {
		t.Errorf("an empty capture wrote %#v, want an empty array", second[8])
	}
}

func TestDesiredRecordDriftWritesTheVerdictWithItsRepairCount(t *testing.T) {
	repaired := time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)
	f := &pgDB{}
	err := PostgresDesired{DB: f}.RecordDrift(context.Background(), []Verdict{
		{ConfigID: pgConfig, Drift: DriftMissing, RepairCount: 2, RepairedAt: repaired},
		{ConfigID: "88888888-8888-4888-8888-888888888888", Drift: DriftSynced},
	})
	if err != nil {
		t.Fatalf("RecordDrift: %v", err)
	}
	if len(f.sql) != 1 {
		t.Fatalf("got %d statements, want the verdicts in one", len(f.sql))
	}
	args := f.args[0]
	if ids := args[0].([]string); len(ids) != 2 || ids[0] != pgConfig {
		t.Errorf("ids %v", ids)
	}
	if states := args[1].([]string); states[0] != "missing" || states[1] != "synced" {
		t.Errorf("states %v", states)
	}
	if counts := args[2].([]int32); counts[0] != 2 || counts[1] != 0 {
		t.Errorf("counts %v", counts)
	}
	times := args[3].([]*time.Time)
	if times[0] == nil || !times[0].Equal(repaired) {
		t.Errorf("repair time %v, want %v", times[0], repaired)
	}
	if times[1] != nil {
		t.Error("a config never repaired got a repair time; the stop would count it")
	}
}

func TestAllocationsReadOnlyWhatTheCeilingPassCanWriteTo(t *testing.T) {
	f := &pgDB{rows: []pgRow{
		{pgConfig, "r-1", int64(5_000), int64(4_000), int64(4_500)},
		{"88888888-8888-4888-8888-888888888888", "r-2", int64(3_000), nil, nil},
	}}
	got, err := PostgresAllocations{DB: f}.For(context.Background(), pgPanel)
	if err != nil {
		t.Fatalf("For: %v", err)
	}
	for _, clause := range []string{`"allocatedCeilingBytes" IS NOT NULL`, `"remoteId" IS NOT NULL`, `"desiredRemote" = 'present'`} {
		if !strings.Contains(f.sql[0], clause) {
			t.Errorf("the read is not limited by %q", clause)
		}
	}
	if len(got) != 2 || got[0].ConfigID != pgConfig || got[0].RemoteID != "r-1" || got[0].AllocatedBytes != 5_000 {
		t.Fatalf("got %+v", got)
	}
	if got[0].AppliedBytes == nil || *got[0].AppliedBytes != 4_000 {
		t.Errorf("applied read %v, want 4000", got[0].AppliedBytes)
	}
	// What we wrote is read beside it, so our own figure is not foreign (F-027-cu).
	if got[0].WrittenBytes == nil || *got[0].WrittenBytes != 4_500 {
		t.Errorf("written read %v, want 4500", got[0].WrittenBytes)
	}
	// No read ever confirmed one: that is not a ceiling of zero, and the
	// override check tells the two apart.
	if got[1].AppliedBytes != nil || got[1].WrittenBytes != nil {
		t.Error("a ceiling never confirmed read as one")
	}
}

func TestAllocationsRecordWritesEveryConfirmationInOneStatement(t *testing.T) {
	at := time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)
	f := &pgDB{}
	err := PostgresAllocations{DB: f}.Record(context.Background(), []AppliedCeiling{
		{ConfigID: pgConfig, Bytes: 4_000, At: at},
		{ConfigID: "88888888-8888-4888-8888-888888888888", Bytes: 3_000, At: at},
	})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if len(f.sql) != 1 {
		t.Fatalf("got %d statements, want one", len(f.sql))
	}
	if !strings.Contains(f.sql[0], `"appliedCeilingBytes"`) || !strings.Contains(f.sql[0], `"ceilingAppliedAt"`) {
		t.Error("the confirmation does not write the applied ceiling and its time")
	}
	if bytes := f.args[0][1].([]int64); bytes[0] != 4_000 || bytes[1] != 3_000 {
		t.Errorf("bytes %v", bytes)
	}
}

func TestPostgresStoresWriteNothingForNothing(t *testing.T) {
	f := &pgDB{}
	ctx := context.Background()
	if err := (PostgresDesired{DB: f}).Record(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := (PostgresDesired{DB: f}).RecordDrift(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := (PostgresAllocations{DB: f}).Record(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := (PostgresAllocations{DB: f}).Wrote(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if len(f.sql) != 0 {
		t.Errorf("%d statements for no rows", len(f.sql))
	}
}

func sameLinks(a, b CapturedLinks) bool {
	if a.RemoteID != b.RemoteID || a.UUID != b.UUID || !a.At.Equal(b.At) || len(a.Lines) != len(b.Lines) {
		return false
	}
	for i := range a.Lines {
		if a.Lines[i] != b.Lines[i] {
			return false
		}
	}
	return true
}

func TestInboundsRecordWritesTheReadAndNeverThePick(t *testing.T) {
	at := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	f := &pgDB{}
	err := PostgresInbounds{DB: f}.Record(context.Background(), pgPanel, []driver.Inbound{
		{RemoteID: "1", Tag: "vless-443", Protocol: "vless", Port: 443, Enabled: true},
		{RemoteID: "2", Tag: "odd", Protocol: "dokodemo-door", Port: 80, Enabled: false},
	}, at)
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if len(f.sql) != 4 {
		t.Fatalf("%d statements, want two upserts, one gone-mark, one stamp", len(f.sql))
	}
	if strings.Contains(f.sql[0], "sold") || strings.Contains(f.sql[0], `"maxClients"`) {
		t.Error("a read writes the admin's pick")
	}
	if !strings.Contains(f.sql[0], `enum_range(NULL::network."ConfigProtocol")`) {
		t.Error("a protocol we do not sell is not stored as null")
	}
	if ids := f.args[2][1].([]string); len(ids) != 2 || ids[0] != "1" || ids[1] != "2" {
		t.Errorf("gone-mark spares %v, want every listed inbound", ids)
	}
	if !strings.Contains(f.sql[3], `"inboundsReadAt"`) {
		t.Error("the read is not stamped: every pass would read again")
	}
}

// F-111-l: a capture is announced to the Grant's owner in the statement that
// writes it (ADR-0021), so an open My services re-reads the lines the moment
// they exist instead of asking on a clock. Only a capture is announced: a
// pass that confirmed a client and read nothing new tells nobody anything.
func TestDesiredRecordAnnouncesACaptureInTheSameStatement(t *testing.T) {
	at := time.Date(2026, 9, 26, 10, 0, 0, 0, time.UTC)
	f := &pgDB{}
	err := PostgresDesired{DB: f}.Record(context.Background(), []Outcome{
		{ConfigID: pgConfig, RemoteID: "r-1", State: StateComplete, At: at, UUID: "uuid-1", Enabled: true, Present: true,
			Links: &CapturedLinks{Lines: []string{"vless://x"}, RemoteID: "r-1", UUID: "uuid-1", At: at}},
	})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	sql := f.sql[0]
	for _, part := range []string{"INSERT INTO automation.outbox_event", "RETURNING", `"grantId"`, `"userId"`, `"tenantId"`, "($13::text, $8::boolean"} {
		if !strings.Contains(sql, part) {
			t.Errorf("the capture's announcement is missing %q", part)
		}
	}
	if got := f.args[0][12]; got != LinksCapturedEvent {
		t.Errorf("announced as %v, want %s", got, LinksCapturedEvent)
	}
}

func TestDesiredRecordAnnouncesAConfirmationOfAGrantsConfigInTheSameStatement(t *testing.T) {
	at := time.Date(2026, 9, 26, 10, 0, 0, 0, time.UTC)
	f := &pgDB{}
	err := PostgresDesired{DB: f}.Record(context.Background(), []Outcome{
		{ConfigID: pgConfig, RemoteID: "r-1", State: StateComplete, At: at, UUID: "uuid-1", Enabled: true, Present: true, Confirmed: true},
	})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if !strings.Contains(f.sql[0], `r."grantId" IS NOT NULL`) {
		t.Error("a confirmation is announced for a config with no Grant: nothing to activate")
	}
	// F-111-o: only the first confirmation — a disable, a rotation or a
	// repair confirmed later has no Grant waiting on it.
	for _, part := range []string{`"confirmedAt" = CASE WHEN $15 THEN COALESCE("confirmedAt", $4)`, `prior."confirmedAt" IS NULL`} {
		if !strings.Contains(f.sql[0], part) {
			t.Errorf("the confirmation is not held to the first one: missing %q", part)
		}
	}
	args := f.args[0]
	if args[13] != ConfirmedEvent || args[14] != true {
		t.Errorf("args %v, want the confirmation announced as %s", args[13:15], ConfirmedEvent)
	}
}

// A pass's batched writes and billing's re-split meet on the same config
// rows. Each takes its locks in id order, or two of them deadlock (40P01)
// and the pass loses its confirmations (F-027-cv).
func TestBatchedConfigWritesLockInIDOrder(t *testing.T) {
	at := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	f := &pgDB{}
	ctx := context.Background()
	if err := (PostgresAllocations{DB: f}).Record(ctx, []AppliedCeiling{{ConfigID: pgConfig, Bytes: 4_000, At: at}}); err != nil {
		t.Fatal(err)
	}
	if err := (PostgresAllocations{DB: f}).Wrote(ctx, []WrittenCeiling{{ConfigID: pgConfig, Bytes: 4_500}}); err != nil {
		t.Fatal(err)
	}
	if err := (PostgresDesired{DB: f}).RecordDrift(ctx, []Verdict{{ConfigID: pgConfig, Drift: "synced"}}); err != nil {
		t.Fatal(err)
	}
	if len(f.sql) != 3 {
		t.Fatalf("got %d statements, want 3", len(f.sql))
	}
	for _, sql := range f.sql {
		if !strings.Contains(sql, "ORDER BY c.id") || !strings.Contains(sql, "FOR NO KEY UPDATE OF c") {
			t.Errorf("a batched write takes its locks in plan order:\n%s", sql)
		}
	}
}
