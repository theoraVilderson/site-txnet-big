package converge_test

import (
	"context"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/converge"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// Provisioning is proved against the fake panel through the Driver interface
// only, and every assertion about the far end reads it back off ListClients —
// the same rule the ceiling tests keep: what we sent is not what the panel
// holds (F-027-z).

type provRig struct {
	panel   *fake.Panel
	desired *converge.MemoryDesired
	allocs  *converge.MemoryAllocations
	conv    *converge.Converger
	at      time.Time
}

func newProvRig(t *testing.T, cfg fake.Config) *provRig {
	t.Helper()
	if cfg.CounterSemantics == "" {
		cfg.CounterSemantics = driver.CounterCumulative
	}
	desired := converge.NewMemoryDesired()
	allocs := converge.NewMemoryAllocations()
	return &provRig{
		panel:   fake.New(cfg),
		desired: desired,
		allocs:  allocs,
		conv: &converge.Converger{
			Provisioning: &converge.Provisioning{Desired: desired},
			Ceilings:     &converge.Ceilings{Allocations: allocs, Counters: collect.NewMemoryCursors()},
		},
		at: time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC),
	}
}

func (r *provRig) pass(t *testing.T) converge.ProvisionReport {
	t.Helper()
	r.at = r.at.Add(time.Minute)
	p := collect.Panel{
		ID: "panel-1", CounterSemantics: driver.CounterCumulative,
		Transport: driver.TransportPull, MaxLineRateBps: gigabit, Driver: r.panel,
	}
	report, err := r.conv.Pass(context.Background(), p, collect.Result{ObservedAt: r.at})
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	return report.Provisioning
}

func (r *provRig) client(t *testing.T, remoteID string) (driver.RemoteClient, bool) {
	t.Helper()
	clients, err := r.panel.ListClients(context.Background())
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	for _, c := range clients {
		if c.RemoteID == remoteID {
			return c, true
		}
	}
	return driver.RemoteClient{}, false
}

func (r *provRig) row(t *testing.T, configID string) converge.DesiredConfig {
	t.Helper()
	row, ok := r.desired.Get(configID)
	if !ok {
		t.Fatalf("no desired row %s", configID)
	}
	return row
}

func bytes(n int64) *int64 { return &n }

func wanted(configID string) converge.DesiredConfig {
	return converge.DesiredConfig{
		ConfigID: configID, UUID: "uuid-" + configID, ClaimTag: "tag-" + configID,
		Protocol: "vless", Enabled: true, Present: true,
		AllocatedBytes: bytes(10 * gb), State: converge.StatePending,
	}
}

func onlyAction(t *testing.T, report converge.ProvisionReport, want converge.Action) converge.ProvisionFinding {
	t.Helper()
	if len(report.Findings) != 1 || report.Findings[0].Action != want {
		t.Fatalf("findings = %+v, want exactly one %s", report.Findings, want)
	}
	return report.Findings[0]
}

// ---- create -----------------------------------------------------------------

func TestACreatedClientCarriesItsCeilingFromTheFirstByte(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	row := wanted("c1")
	row.ServedBytes = 2 * gb // a rebuild after a purge: the lifetime it already carried counts
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionCreated)

	got := r.row(t, "c1")
	if got.RemoteID == "" {
		t.Fatal("the panel's id for the new client was not recorded")
	}
	if got.State != converge.StatePartial {
		t.Fatalf("state after the create = %s, want partial: a create is not confirmed until a read shows it", got.State)
	}
	client, ok := r.client(t, got.RemoteID)
	if !ok {
		t.Fatal("the panel holds no client for the config")
	}
	if client.DataLimitBytes != 8*gb {
		t.Fatalf("created under %d, want 8 GB: allocation less what the config already served", client.DataLimitBytes)
	}
	if client.UUID != "uuid-c1" || client.Label != "tag-c1" || client.InboundRemoteID != "inbound-1" || !client.Enabled {
		t.Fatalf("created client = %+v", client)
	}

	if report := r.pass(t); len(report.Findings) != 0 {
		t.Fatalf("second pass wrote %+v, want nothing", report.Findings)
	}
	if got := r.row(t, "c1"); got.State != converge.StateComplete {
		t.Fatalf("state after the confirming read = %s, want complete", got.State)
	}
}

func TestNoClientIsCreatedWithoutAnAllowanceToCreateItUnder(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	unallocated := wanted("c1")
	unallocated.AllocatedBytes = nil
	spent := wanted("c2")
	spent.ServedBytes = 10 * gb
	r.desired.Put("panel-1", unallocated)
	r.desired.Put("panel-1", spent)

	report := r.pass(t)

	if n := r.panel.CallCount("CreateClient"); n != 0 {
		t.Fatalf("CreateClient called %d times: a client with no ceiling is unpaid traffic", n)
	}
	if report.Skipped != 2 || len(report.Findings) != 2 ||
		report.Findings[0].Action != converge.ActionAwaitingAllocation ||
		report.Findings[1].Action != converge.ActionAllowanceExhausted {
		t.Fatalf("report = %+v", report)
	}
}

func TestACreateThatLandedIsAdoptedNotRepeated(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	// The first create reached the panel and its answer did not reach us.
	if _, err := r.panel.CreateClient(context.Background(), driver.CreateClientRequest{
		UUID: "uuid-c1", InboundRemoteID: "inbound-1", Protocol: "vless", DataLimitBytes: gb, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	r.desired.Put("panel-1", wanted("c1"))

	finding := onlyAction(t, r.pass(t), converge.ActionAdopted)

	if n := r.panel.CallCount("CreateClient"); n != 1 {
		t.Fatalf("CreateClient called %d times, want the one that already landed", n)
	}
	if got := r.row(t, "c1"); got.RemoteID != finding.RemoteID || got.RemoteID == "" {
		t.Fatalf("adopted remote id = %q, row holds %q", finding.RemoteID, got.RemoteID)
	}
}

func TestNoInboundForTheProtocolIsAFindingNotAGuess(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	row := wanted("c1")
	row.Protocol = "trojan"
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionNoInbound)
	if n := r.panel.CallCount("CreateClient"); n != 0 {
		t.Fatalf("CreateClient called %d times onto an inbound of another protocol", n)
	}
}

// ---- change -----------------------------------------------------------------

func TestDisablingIsCarriedAndConfirmedByTheRead(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.panel.Given("remote-a")
	row := wanted("c1")
	row.RemoteID, row.UUID, row.Enabled = "remote-a", "remote-a", false
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionDisabled)
	if client, _ := r.client(t, "remote-a"); client.Enabled {
		t.Fatal("the panel still serves a config we disabled")
	}
	r.pass(t)
	if got := r.row(t, "c1"); got.State != converge.StateComplete {
		t.Fatalf("state = %s, want complete once the panel reads disabled", got.State)
	}
}

func TestARegeneratedCredentialReplacesTheOldOneAndKeepsTheCeiling(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.panel.Given("remote-a")
	if err := r.panel.SetClientDataLimit(context.Background(), "remote-a", 5*gb); err != nil {
		t.Fatal(err)
	}
	row := wanted("c1")
	row.RemoteID, row.UUID = "remote-a", "uuid-fresh"
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionCredentialRotated)

	client, _ := r.client(t, "remote-a")
	if client.UUID != "uuid-fresh" {
		t.Fatalf("panel uuid = %q: the old credential still works", client.UUID)
	}
	if client.DataLimitBytes != 5*gb {
		t.Fatalf("ceiling = %d after the rotation: the ceiling is the ceiling loop's, never reset by an update", client.DataLimitBytes)
	}
}

// ---- remove -----------------------------------------------------------------

func TestAnAbsentConfigIsDeletedAndItsRemoteIdClearedOnlyOnceTheReadConfirms(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.panel.Given("remote-a")
	row := wanted("c1")
	row.RemoteID, row.UUID, row.Present, row.Enabled = "remote-a", "remote-a", false, false
	r.desired.Put("panel-1", row)
	// A stale share still on the row must not be written to a client this pass deleted.
	r.allocs.Allocate("panel-1", converge.Allocation{ConfigID: "c1", RemoteID: "remote-a", AllocatedBytes: 10 * gb})

	onlyAction(t, r.pass(t), converge.ActionDeleted)
	if _, ok := r.client(t, "remote-a"); ok {
		t.Fatal("the client is still on the panel")
	}
	if n := r.panel.CallCount("SetClientDataLimit"); n != 0 {
		t.Fatalf("SetClientDataLimit called %d times on a client the same pass deleted", n)
	}
	if got := r.row(t, "c1"); got.RemoteID != "remote-a" || got.State != converge.StatePartial {
		t.Fatalf("row = %+v, want remoteId kept until a read confirms the delete", got)
	}

	r.pass(t)
	if got := r.row(t, "c1"); got.RemoteID != "" || got.State != converge.StateComplete {
		t.Fatalf("row = %+v, want remoteId cleared and complete (invariant 15)", got)
	}
}

func TestAPresentConfigWhoseClientVanishedIsNotRecreatedBlind(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	row := wanted("c1")
	row.RemoteID = "remote-gone"
	r.desired.Put("panel-1", row)

	report := r.pass(t)
	if report.Skipped != 1 || r.panel.CallCount("CreateClient") != 0 {
		t.Fatalf("report = %+v, creates = %d: a rename is F-027-aa's verdict, and a second client would double the seat",
			report, r.panel.CallCount("CreateClient"))
	}
}

// ---- the pass ---------------------------------------------------------------

func TestOneReadOfTheClientsServesProvisioningAndCeilings(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.panel.Given("remote-a")
	row := wanted("c1")
	row.RemoteID, row.UUID, row.Enabled = "remote-a", "remote-a", false
	r.desired.Put("panel-1", row)
	r.allocs.Allocate("panel-1", converge.Allocation{ConfigID: "c1", RemoteID: "remote-a", AllocatedBytes: 10 * gb})

	r.pass(t)

	if n := r.panel.CallCount("ListClients"); n != 1 {
		t.Fatalf("ListClients called %d times in one pass, want 1 (invariant 34)", n)
	}
}

func TestARefusedWriteLeavesTheRowAndTheRestOfThePanelGoesOn(t *testing.T) {
	r := newProvRig(t, fake.Config{Unsupported: map[driver.RowKey]bool{driver.RowEnableDisableClient: true}})
	r.panel.Given("remote-a")
	off := wanted("c1")
	off.RemoteID, off.UUID, off.Enabled = "remote-a", "remote-a", false
	r.desired.Put("panel-1", off)
	r.desired.Put("panel-1", wanted("c2"))

	report := r.pass(t)

	if report.Failed != 1 || report.Written != 1 {
		t.Fatalf("report = %+v, want one refusal and one create", report)
	}
	if got := r.row(t, "c1"); got.State != converge.StatePending {
		t.Fatalf("state = %s after a refused write, want pending", got.State)
	}
	if kind, ok := converge.FaultKindOf(report.Findings[0].Err); !ok || kind != driver.FaultUnsupported {
		t.Fatalf("refusal = %v, want the driver's own classification", report.Findings[0].Err)
	}
}
