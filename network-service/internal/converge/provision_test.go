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
	// rateLimitable is the panel's `per_client_rate_limit` answer (F-311-p).
	rateLimitable bool
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
		RateLimitable: r.rateLimitable,
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
		Protocol: "vless", InboundRemoteID: "inbound-1", Enabled: true, Present: true,
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

func TestAnUnlimitedConfigIsCreatedWithNoLimitAndLeftThat(t *testing.T) {
	// F-111-r: an unlimited Grant has no allocation by construction (F-111-q),
	// so waiting for one would leave its configs off the panel for good. No
	// limit is the whole of what it bought, and it is not a money hole.
	r := newProvRig(t, fake.Config{})
	row := wanted("c1")
	row.Unlimited, row.AllocatedBytes, row.ServedBytes = true, nil, 400*gb
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionCreated)
	got := r.row(t, "c1")
	client, ok := r.client(t, got.RemoteID)
	if !ok {
		t.Fatal("the panel holds no client for the unlimited config")
	}
	if client.DataLimitBytes != 0 {
		t.Fatalf("created under a %d-byte limit, want none", client.DataLimitBytes)
	}

	report := r.pass(t)
	if len(report.Findings) != 0 || r.row(t, "c1").State != converge.StateComplete {
		t.Fatalf("the confirming read: findings %+v state %s, want none and complete", report.Findings, r.row(t, "c1").State)
	}
	if n := r.panel.CallCount("SetClientDataLimit"); n != 0 {
		t.Fatalf("SetClientDataLimit called %d times on a client that should carry no limit", n)
	}
	if d := r.row(t, "c1").Drift; d != "" && d != converge.DriftSynced {
		t.Fatalf("drift = %s, want synced", d)
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

func TestAClientIsCreatedOnTheInboundItsConfigWasPlacedOn(t *testing.T) {
	// F-114-b: the admin picked 2 and 3; the first enabled vless inbound is 1.
	r := newProvRig(t, fake.Config{Inbounds: []driver.Inbound{
		{RemoteID: "1", Protocol: "vless", Enabled: true},
		{RemoteID: "2", Protocol: "vless", Enabled: true},
		{RemoteID: "3", Protocol: "trojan", Enabled: true},
	}})
	on2, on3 := wanted("c1"), wanted("c2")
	on2.InboundRemoteID = "2"
	on3.InboundRemoteID, on3.Protocol = "3", "trojan"
	r.desired.Put("panel-1", on2)
	r.desired.Put("panel-1", on3)

	r.pass(t)

	for id, inbound := range map[string]string{"c1": "2", "c2": "3"} {
		client, ok := r.client(t, r.row(t, id).RemoteID)
		if !ok || client.InboundRemoteID != inbound {
			t.Fatalf("%s created on %+v, want inbound %s", id, client, inbound)
		}
	}
	if n := r.panel.CallCount("ListInbounds"); n != 1 {
		t.Fatalf("ListInbounds called %d times in one pass, want 1", n)
	}
}

func TestNothingPickedOrAPickThepanelNoLongerServesCreatesNothing(t *testing.T) {
	r := newProvRig(t, fake.Config{Inbounds: []driver.Inbound{
		{RemoteID: "1", Protocol: "vless", Enabled: true},
		{RemoteID: "2", Protocol: "vless", Enabled: false},
	}})
	for id, inbound := range map[string]string{"none": "", "disabled": "2", "gone": "9"} {
		row := wanted(id)
		row.InboundRemoteID = inbound
		r.desired.Put("panel-1", row)
	}

	report := r.pass(t)

	if n := r.panel.CallCount("CreateClient"); n != 0 {
		t.Fatalf("CreateClient called %d times: never the first enabled inbound in place of the pick", n)
	}
	if len(report.Findings) != 3 {
		t.Fatalf("findings = %+v", report.Findings)
	}
	for _, f := range report.Findings {
		if f.Action != converge.ActionNoInbound {
			t.Fatalf("finding %+v, want no_inbound", f)
		}
	}
}

// ---- inventory ----------------------------------------------------------------

func TestThePanelsInboundsAreReadWhenDueAndKeptWhenGone(t *testing.T) {
	cfg := fake.Config{Inbounds: []driver.Inbound{
		{RemoteID: "1", Protocol: "vless", Enabled: true},
		{RemoteID: "2", Protocol: "trojan", Enabled: true},
	}}
	r := newProvRig(t, cfg)
	store := converge.NewMemoryInbounds()
	r.conv.Provisioning.Inbounds = store

	r.pass(t)
	if _, ok := store.Get("panel-1", "2"); !ok || r.panel.CallCount("ListInbounds") != 1 {
		t.Fatal("a panel never read was not read on its first pass")
	}
	r.pass(t)
	if n := r.panel.CallCount("ListInbounds"); n != 1 {
		t.Fatalf("read again a minute later (%d reads): the inventory is read every %s", n, converge.InboundReadEvery)
	}

	// The admin asks for a refresh after removing 2 on the panel.
	gone := newProvRig(t, fake.Config{Inbounds: cfg.Inbounds[:1]})
	gone.conv.Provisioning.Inbounds = store
	store.RequestRead("panel-1")
	gone.at = r.at
	gone.pass(t)
	if row, _ := store.Get("panel-1", "2"); row.Gone.IsZero() {
		t.Fatal("an inbound the panel no longer lists is not marked gone")
	}
	if row, _ := store.Get("panel-1", "1"); !row.Gone.IsZero() {
		t.Fatal("an inbound still listed is marked gone")
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

func TestAPresentConfigWhoseClientVanishedIsRecreatedWithItsCeiling(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	row := wanted("c1")
	row.RemoteID = "remote-gone"
	r.desired.Put("panel-1", row)

	finding := onlyAction(t, r.pass(t), converge.ActionRecreated)
	client, ok := r.client(t, finding.RemoteID)
	if !ok || client.Label != "tag-c1" || client.DataLimitBytes != 10*gb {
		t.Fatalf("recreated %+v, want our tag and the 10 GB share: a recreate is a create, ceiling first", client)
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

// F-027-ch: a row placed before F-114-b names no inbound. The pass writes down
// the inbound it found the client on — or created it on — so the row stops
// being a guess, and an inbound a group takes is counted by where its
// clients actually are.
func TestARowWithNoInboundOfItsOwnRecordsTheOneItsClientIsOn(t *testing.T) {
	r := newProvRig(t, fake.Config{Inbounds: []driver.Inbound{
		{RemoteID: "1", Protocol: "vless", Enabled: true},
		{RemoteID: "2", Protocol: "vless", Enabled: true},
	}})
	legacy := wanted("c1")
	legacy.InboundRemoteID, legacy.InboundResolved = "2", true
	r.desired.Put("panel-1", legacy)

	r.pass(t)
	row := r.row(t, "c1")
	if row.InboundResolved || row.InboundRemoteID != "2" {
		t.Fatalf("created on 2, recorded %+v", row)
	}

	// Already on the panel, and the row does not know where: the client says.
	row.InboundRemoteID, row.InboundResolved = "1", true
	r.desired.Put("panel-1", row)
	r.pass(t)
	if got := r.row(t, "c1"); got.InboundResolved || got.InboundRemoteID != "2" {
		t.Fatalf("client on 2, recorded %+v — the resolution is a guess, the client is the fact", got)
	}
}

func TestARowThatNamesItsInboundIsNeverRewrittenByThePass(t *testing.T) {
	r := newProvRig(t, fake.Config{Inbounds: []driver.Inbound{{RemoteID: "1", Protocol: "vless", Enabled: true}}})
	row := wanted("c1")
	row.InboundRemoteID = "1"
	r.desired.Put("panel-1", row)
	r.pass(t)
	r.pass(t)
	if got := r.row(t, "c1"); got.InboundResolved || got.InboundRemoteID != "1" {
		t.Fatalf("row rewritten: %+v", got)
	}
}

// A push panel counts a client's bytes from its create: User Manager's total
// starts at zero with the user, and ours, the Σ of its `radius_session`
// marks, does not. A client re-made after a delete on the router is created
// under what is left, and the Σ it was made at is recorded as the offset
// every later ceiling on it is translated by (F-027-du).
func TestAClientMadeAgainOnAPushPanelCountsFromItsCreate(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	row := wanted("c1")
	row.RemoteID = "gone-from-the-router"
	row.SessionBytes, row.ServedBytes = 3*gb, 3*gb
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionRecreated)

	got := r.row(t, "c1")
	client, ok := r.client(t, got.RemoteID)
	if !ok || client.DataLimitBytes != 7*gb {
		t.Fatalf("re-made under %d, want 7 GB: the allocation less the 3 GB already served", client.DataLimitBytes)
	}
	if got.SessionBaselineBytes != 3*gb {
		t.Fatalf("baseline = %d, want 3 GB: the router's counter starts at this create", got.SessionBaselineBytes)
	}
}

const mb = int64(1) << 20

type oneCounter collect.Counter

func (c oneCounter) Counter(string, string) (collect.Counter, bool) { return collect.Counter(c), true }

// The ceiling pass translates a push client's allocation by the same
// baseline: 3.3 GB served, 1 GB of it before the client was last made, so
// User Manager's own total reads 2.3 GB and a 10 GB allocation is 9 GB on the
// router — never 10 again, which is a re-made user served twice (F-027-du).
func TestAPushClientsCeilingIsTranslatedByItsBaseline(t *testing.T) {
	c := oneCounter(collect.SessionCounter(300*mb, 3000*mb, 1000*mb))
	p := collect.Panel{ID: "panel-push", CounterSemantics: driver.CounterSession}
	if off := converge.OffsetBytes(c, p, "c1"); off != 1000*mb {
		t.Fatalf("offset = %d, want the 1000 MB baseline", off)
	}
	if got := converge.PanelCeiling(10_000*mb, converge.OffsetBytes(c, p, "c1")); got != 9_000*mb {
		t.Fatalf("ceiling = %d, want 9000 MB", got)
	}
}

// ---- speed cap (F-311-p) ----------------------------------------------------

const twentyMbit = 20_000_000

func TestAGrantsSpeedCapIsWrittenWhereThePanelHoldsOneAndConfirmedByTheRead(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.rateLimitable = true
	r.panel.Given("remote-a")
	row := wanted("c1")
	row.RemoteID, row.UUID, row.RateCapBps = "remote-a", "remote-a", twentyMbit
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionRateLimited)
	if client, _ := r.client(t, "remote-a"); client.RateLimitBps != twentyMbit {
		t.Fatalf("panel rate = %d, want %d", client.RateLimitBps, twentyMbit)
	}
	if report := r.pass(t); len(report.Findings) != 0 {
		t.Fatalf("a cap the panel holds is written again: %+v", report.Findings)
	}
	if got := r.row(t, "c1"); got.State != converge.StateComplete {
		t.Fatalf("state = %s, want complete once the panel reads the cap", got.State)
	}
}

func TestALiftedCapIsWrittenAsNoCap(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.rateLimitable = true
	r.panel.Given("remote-a")
	if err := r.panel.SetClientRateLimit(context.Background(), "remote-a", twentyMbit); err != nil {
		t.Fatal(err)
	}
	row := wanted("c1")
	row.RemoteID, row.UUID = "remote-a", "remote-a"
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionRateLimited)
	if client, _ := r.client(t, "remote-a"); client.RateLimitBps != 0 {
		t.Fatalf("panel rate = %d, want 0: no row is no cap", client.RateLimitBps)
	}
}

func TestACapIsNeverSentToAPanelThatCannotHoldOne(t *testing.T) {
	r := newProvRig(t, fake.Config{Unsupported: map[driver.RowKey]bool{driver.RowPerClientRateLimit: true}})
	r.panel.Given("remote-a")
	row := wanted("c1")
	row.RemoteID, row.UUID, row.RateCapBps = "remote-a", "remote-a", twentyMbit
	r.desired.Put("panel-1", row)

	if report := r.pass(t); len(report.Findings) != 0 {
		t.Fatalf("findings = %+v, want none: the cap is recorded, not enforced, where the panel has none", report.Findings)
	}
	if got := r.row(t, "c1"); got.State != converge.StateComplete {
		t.Fatalf("state = %s, want complete", got.State)
	}
}

func TestANewClientIsCreatedUnderItsGrantsCap(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.rateLimitable = true
	row := wanted("c1")
	row.RateCapBps = twentyMbit
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionCreated)
	if client, _ := r.client(t, r.row(t, "c1").RemoteID); client.RateLimitBps != twentyMbit {
		t.Fatalf("created rate = %d, want %d: the cap goes in with the create", client.RateLimitBps, twentyMbit)
	}
}
