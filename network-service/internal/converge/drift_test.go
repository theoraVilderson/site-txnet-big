package converge_test

import (
	"context"
	"sync"
	"testing"

	"network-service/internal/collect"
	"network-service/internal/converge"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// The drift comparison is proved through the collection loop, not by calling
// the converger by hand: the whole point of a re-keyed `remoteId` is that the
// next pass attributes the client's usage to its config again, and a `reset`
// verdict only exists in the pass that detected the reset (F-027-aa).

// passRecorder is the loop's converger: the real one, with its report kept.
type passRecorder struct {
	conv *converge.Converger

	mu   sync.Mutex
	last converge.ConvergeReport
}

func (r *passRecorder) Converge(ctx context.Context, p collect.Panel, res collect.Result) error {
	report, err := r.conv.Pass(ctx, p, res)
	r.mu.Lock()
	r.last = report
	r.mu.Unlock()
	return err
}

type driftRig struct {
	panel   *fake.Panel
	desired *converge.MemoryDesired
	allocs  *converge.MemoryAllocations
	loop    *collect.Loop
	conv    *passRecorder
}

// newDriftRig wires one panel the way the database-backed source will: the
// panel's `Configs` map and the allocator's rows are both read off the config
// rows as they are at the start of the pass, so a `remoteId` the drift
// comparison re-keyed is what the next pass attributes by.
func newDriftRig(t *testing.T, cfg fake.Config) *driftRig {
	t.Helper()
	if cfg.CounterSemantics == "" {
		cfg.CounterSemantics = driver.CounterCumulative
	}
	r := &driftRig{
		panel:   fake.New(cfg),
		desired: converge.NewMemoryDesired(),
		allocs:  converge.NewMemoryAllocations(),
	}
	cursors := collect.NewMemoryCursors()
	r.conv = &passRecorder{conv: &converge.Converger{
		Provisioning: &converge.Provisioning{Desired: r.desired},
		Ceilings:     &converge.Ceilings{Allocations: r.allocs, Counters: cursors},
	}}
	r.loop = &collect.Loop{
		Source: collect.PanelsFunc(func(ctx context.Context) ([]collect.Panel, error) {
			rows, err := r.desired.For(ctx, "panel-1")
			if err != nil {
				return nil, err
			}
			configs := map[string]collect.ConfigRef{}
			for _, row := range rows {
				if row.RemoteID == "" {
					continue
				}
				configs[row.RemoteID] = collect.ConfigRef{ConfigID: row.ConfigID, Protocol: row.Protocol}
				if row.AllocatedBytes != nil {
					r.allocs.Allocate("panel-1", converge.Allocation{
						ConfigID: row.ConfigID, RemoteID: row.RemoteID, AllocatedBytes: *row.AllocatedBytes,
					})
				}
			}
			return []collect.Panel{{
				ID: "panel-1", CounterSemantics: cfg.CounterSemantics, Transport: driver.TransportPull,
				MaxLineRateBps: gigabit, Driver: r.panel, Configs: configs,
			}}, nil
		}),
		Sink:     sink{},
		Cursors:  cursors,
		Ceilings: r.conv,
	}
	return r
}

func (r *driftRig) pass(t *testing.T) converge.ConvergeReport {
	t.Helper()
	report, err := r.loop.Pass(context.Background())
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(report.Failed) > 0 {
		t.Fatalf("pass failed on %+v", report.Failed)
	}
	r.conv.mu.Lock()
	defer r.conv.mu.Unlock()
	return r.conv.last
}

// established puts config c1 on the panel and runs it to `complete`: the
// create, then the read that confirms it and adopts its counter.
func (r *driftRig) established(t *testing.T) converge.DesiredConfig {
	t.Helper()
	r.desired.Put("panel-1", wanted("c1"))
	r.pass(t)
	r.pass(t)
	row := r.drift(t, converge.DriftSynced)
	if row.State != converge.StateComplete || row.RemoteID != "remote-1" {
		t.Fatalf("setup: row = %+v, want remote-1 complete", row)
	}
	return row
}

func (r *driftRig) drift(t *testing.T, want converge.DriftState) converge.DesiredConfig {
	t.Helper()
	row, ok := r.desired.Get("c1")
	if !ok {
		t.Fatal("no desired row c1")
	}
	got := row.Drift
	if got == "" {
		got = converge.DriftSynced // a row never judged holds the column's default
	}
	if got != want {
		t.Fatalf("drift = %q, want %q (row %+v)", got, want, row)
	}
	return row
}

func (r *driftRig) clients(t *testing.T) []driver.RemoteClient {
	t.Helper()
	clients, err := r.panel.ListClients(context.Background())
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	return clients
}

// ---- identity: remoteId -> claimTag -> uuid ---------------------------------

func TestARenamedClientIsFollowedByItsTagAndNotRecreated(t *testing.T) {
	r := newDriftRig(t, fake.Config{})
	r.established(t)

	r.panel.Rename("remote-1", "alice-by-admin")
	r.pass(t)

	row := r.drift(t, converge.DriftRenamed)
	if row.RemoteID != "alice-by-admin" {
		t.Fatalf("remoteId = %q, want the new name: the next pass attributes by it", row.RemoteID)
	}
	if got := r.panel.CallCount("CreateClient"); got != 1 {
		t.Fatalf("CreateClient called %d times, want 1: a renamed client recreated is a second seat", got)
	}

	r.panel.Serve("alice-by-admin", 0, 1*gb)
	r.pass(t) // the counter is adopted under its new name
	r.panel.Serve("alice-by-admin", 0, 1*gb)
	report, err := r.loop.Pass(context.Background())
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if report.Unattributed != 0 || report.Deltas != 1 {
		t.Fatalf("after the re-key: %d deltas, %d unattributed; want the usage billed to c1", report.Deltas, report.Unattributed)
	}
	r.drift(t, converge.DriftSynced)
}

func TestARebuiltClientIsFoundByItsUUIDAndGetsItsTagAndCeilingBack(t *testing.T) {
	r := newDriftRig(t, fake.Config{})
	r.established(t)

	r.panel.Rebuild("remote-1", "remote-99")
	report := r.pass(t)

	row := r.drift(t, converge.DriftRebuilt)
	if row.RemoteID != "remote-99" {
		t.Fatalf("remoteId = %q, want remote-99", row.RemoteID)
	}
	clients := r.clients(t)
	if len(clients) != 1 {
		t.Fatalf("panel holds %d clients, want the one rebuilt", len(clients))
	}
	if clients[0].Label != "tag-c1" {
		t.Fatalf("label = %q, want our tag back: without it the next rename is a rebuild", clients[0].Label)
	}
	if clients[0].DataLimitBytes != 10*gb {
		t.Fatalf("rebuilt client enforcing %d, want 10 GB in the same pass: a rebuilt client has no limit", clients[0].DataLimitBytes)
	}
	if got := r.panel.CallCount("CreateClient"); got != 1 {
		t.Fatalf("CreateClient called %d times, want 1", got)
	}
	if len(report.Provisioning.Orphans) != 0 {
		t.Fatalf("orphans = %v, want none: the rebuilt client is ours", report.Provisioning.Orphans)
	}
}

func TestAClientGoneByEveryKeyIsMissingAndRecreatedUnderItsOwnTag(t *testing.T) {
	r := newDriftRig(t, fake.Config{})
	r.established(t)

	r.panel.Remove("remote-1")
	r.pass(t)

	row := r.drift(t, converge.DriftMissing)
	clients := r.clients(t)
	if len(clients) != 1 || clients[0].Label != "tag-c1" || clients[0].RemoteID != row.RemoteID {
		t.Fatalf("panel holds %+v, row %q: want one client recreated under our tag and the row on it", clients, row.RemoteID)
	}
	// The anti-flap stop that bounds this repair is containment_test.go's.
}

func TestAClientNoConfigClaimsIsAnOrphanAndIsLeftAlone(t *testing.T) {
	r := newDriftRig(t, fake.Config{})
	r.established(t)
	r.panel.Given("stranger")

	report := r.pass(t)

	if got := report.Provisioning.Orphans; len(got) != 1 || got[0] != "stranger" {
		t.Fatalf("orphans = %v, want [stranger]", got)
	}
	if len(r.clients(t)) != 2 || r.panel.CallCount("DeleteClient") != 0 {
		t.Fatal("an orphan was touched: the default policy reports and does nothing")
	}
	r.drift(t, converge.DriftSynced)
}

func TestADeletedConfigFollowsItsRenamedClient(t *testing.T) {
	r := newDriftRig(t, fake.Config{})
	row := r.established(t)

	r.panel.Rename("remote-1", "alice-by-admin")
	row.Present, row.Enabled = false, false
	r.desired.Put("panel-1", row)
	r.pass(t)

	if clients := r.clients(t); len(clients) != 0 {
		t.Fatalf("panel still holds %+v: a rename must not keep a deleted config's seat", clients)
	}
}

// ---- verdicts the ceiling pass supplies -------------------------------------

func TestACounterResetIsTheResetVerdict(t *testing.T) {
	r := newDriftRig(t, fake.Config{})
	r.established(t)
	r.panel.Serve("remote-1", 0, 4*gb)
	r.pass(t)

	r.panel.ZeroCounter("remote-1")
	r.pass(t)

	r.drift(t, converge.DriftReset)
}

func TestACeilingSomebodyElseWroteIsLimitOverridden(t *testing.T) {
	r := newDriftRig(t, fake.Config{})
	r.established(t)
	r.pass(t) // the ceiling pass confirms the 10 GB it created under

	if err := r.panel.SetClientDataLimit(context.Background(), "remote-1", 500*gb); err != nil {
		t.Fatalf("operator write: %v", err)
	}
	r.pass(t)

	r.drift(t, converge.DriftLimitOverridden)
}

func TestOurOwnNewAllocationIsNotAnOverride(t *testing.T) {
	r := newDriftRig(t, fake.Config{})
	row := r.established(t)
	r.pass(t)

	row.AllocatedBytes = bytes(20 * gb) // a top-up: the panel's 10 GB is ours, only stale
	r.desired.Put("panel-1", row)
	r.pass(t)

	r.drift(t, converge.DriftSynced)
}
