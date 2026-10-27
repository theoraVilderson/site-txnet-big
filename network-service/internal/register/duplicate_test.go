package register_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"network-service/internal/anchor"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/register"
)

// A panel is registered once (F-027-ce, ADR-0090 decision 1). F-027-cd refuses
// the same address twice; this is the same panel under another one — a second
// domain, or its bare IP. Two rows over one panel each read every client on
// it, call the other's orphans and, under `delete_remote`, delete them. What
// would break silently:
//
//   - a copy passing as new: another non-retired panel's anchor on it names
//     that panel (F-027-ey, ADR-0130 decision 3);
//   - a server refused forever for clients another panel left behind: a claim
//     tag of its configs with no anchor of its own is a warning, not a refusal;
//   - an empty copy passing because it carries nothing of ours: a suspect —
//     same inbound set, or same IP — gets a canary, a disabled client created
//     through the registered panel and looked for here;
//   - the canary left behind, on either answer;
//   - a panel refused because the check itself could not run: no canary, no
//     verdict — the panel stays `pending` with a fault naming the suspect.

const holderID = "panel-a"

// registered is panel A, accepted, at its own address, with the fake's
// default inbound recorded (`inbound-1`, 443, vless).
func registered(ip string) register.Registered {
	return register.Registered{
		Pending:   pending(holderID, driver.TransportPull, driver.CounterCumulative),
		Name:      "de-fra-1",
		IPAddress: ip,
		Inbounds:  []register.InboundKey{{RemoteID: "inbound-1", Port: 443, Protocol: "vless"}},
	}
}

// dupSetup registers A (driven by a) and leaves B (driven by b) pending.
func dupSetup(a, b *fake.Panel, holder register.Registered, resolve map[string][]string) (*register.Registrar, *register.MemoryStore) {
	r, store, _ := setup(map[string]driver.Driver{holderID: a, "panel-b": b}, pending("panel-b", driver.TransportPull, driver.CounterCumulative))
	store.PutRegistered(holder, driver.ReviewAccepted)
	r.Resolve = func(_ context.Context, host string) ([]string, error) {
		if host == "panel-b.example" && resolve[host] == nil {
			return []string{testedIP}, nil // B must resolve to be tested at all (F-027-ez)
		}
		return resolve[host], nil
	}
	return r, store
}

func TestAPanelCarryingAnotherPanelsAnchorIsThatPanel(t *testing.T) {
	a, b := fake.New(fake.Config{}), fake.New(fake.Config{})
	plant(t, b, "anchor-a", "u-anchor-a")
	holder := registered("")
	holder.Anchor = anchor.Anchor{Tag: "anchor-a", UUID: "u-anchor-a", RemoteID: "1"}
	r, store := dupSetup(a, b, holder, nil)

	pass(t, r)
	got := store.Record("panel-b")
	if got.ReviewState != driver.ReviewRefused || got.DuplicateOf != holderID {
		t.Fatalf("B = %s duplicate of %q, want refused as a duplicate of %s", got.ReviewState, got.DuplicateOf, holderID)
	}
	if a.CallCount("CreateClient") != 0 {
		t.Fatal("an anchor is proof enough: no canary")
	}
}

func TestClientsAnotherPanelLeftBehindAreAWarningNotARefusal(t *testing.T) {
	a, b := fake.New(fake.Config{}), fake.New(fake.Config{})
	plant(t, b, "ct-42", "u-42") // A's config, left behind; A's anchor is not here
	holder := registered("")
	holder.Anchor = anchor.Anchor{Tag: "anchor-a", UUID: "u-anchor-a", RemoteID: "1"}
	r, store := dupSetup(a, b, holder, nil)
	store.Claim(holderID, "ct-42", "u-42")

	report := pass(t, r)
	if got := store.Record("panel-b"); got.ReviewState != driver.ReviewAccepted || got.DuplicateOf != "" {
		t.Fatalf("B = %s duplicate of %q, want accepted: leftovers are not a duplicate", got.ReviewState, got.DuplicateOf)
	}
	if report.Leftovers != 1 {
		t.Fatalf("leftovers warned %d times, want once", report.Leftovers)
	}
}

func TestARetiredPanelsAnchorNamesNoDuplicate(t *testing.T) {
	a, b := fake.New(fake.Config{Inbounds: []driver.Inbound{{RemoteID: "x", Protocol: "vmess", Port: 1, Enabled: true}}}), fake.New(fake.Config{})
	plant(t, b, "anchor-a", "u-anchor-a")
	holder := registered("")
	holder.Inbounds = []register.InboundKey{{RemoteID: "x", Port: 1, Protocol: "vmess"}}
	holder.Anchor = anchor.Anchor{Tag: "anchor-a", UUID: "u-anchor-a", RemoteID: "1"}
	r, store := dupSetup(a, b, holder, nil)
	store.Retire(holderID)

	pass(t, r)
	if got := store.Record("panel-b"); got.ReviewState != driver.ReviewAccepted || got.DuplicateOf != "" {
		t.Fatalf("B = %s duplicate of %q, want accepted: an archived panel holds no server", got.ReviewState, got.DuplicateOf)
	}
}

// plant puts a disabled client with this tag and uuid on p.
func plant(t *testing.T, p *fake.Panel, tag, uuid string) {
	t.Helper()
	if _, err := p.CreateClient(context.Background(), driver.CreateClientRequest{ClaimTag: tag, UUID: uuid, InboundRemoteID: "inbound-1"}); err != nil {
		t.Fatal(err)
	}
}

func TestAnEmptyCopyIsFoundByTheCanaryAndTheCanaryIsDeleted(t *testing.T) {
	same := fake.New(fake.Config{}) // one panel, two rows
	r, store := dupSetup(same, same, registered(""), nil)

	pass(t, r)
	got := store.Record("panel-b")
	if got.ReviewState != driver.ReviewRefused || got.DuplicateOf != holderID {
		t.Fatalf("B = %s duplicate of %q, want refused as a duplicate of %s", got.ReviewState, got.DuplicateOf, holderID)
	}
	left, _ := same.ListClients(context.Background())
	if len(left) != 0 {
		t.Fatalf("the canary was left on the panel: %+v", left)
	}
}

func TestASuspectThatDoesNotSeeTheCanaryIsAnotherPanel(t *testing.T) {
	a, b := fake.New(fake.Config{}), fake.New(fake.Config{}) // same inbound set, two servers
	r, store := dupSetup(a, b, registered(""), nil)

	pass(t, r)
	if got := store.Record("panel-b"); got.ReviewState != driver.ReviewAccepted || got.DuplicateOf != "" {
		t.Fatalf("B = %s duplicate of %q, want accepted", got.ReviewState, got.DuplicateOf)
	}
	if a.CallCount("CreateClient") != 1 || a.CallCount("DeleteClient") != 1 {
		t.Fatalf("canary on A: %d created, %d deleted; want one of each", a.CallCount("CreateClient"), a.CallCount("DeleteClient"))
	}
	if created, _ := a.ListClients(context.Background()); len(created) != 0 {
		t.Fatalf("the canary was left on A: %+v", created)
	}
}

func TestNoSuspectNoCanary(t *testing.T) {
	a := fake.New(fake.Config{})
	b := fake.New(fake.Config{Inbounds: []driver.Inbound{{RemoteID: "7", Protocol: "vmess", Port: 8443, Enabled: true}}})
	r, store := dupSetup(a, b, registered("203.0.113.1"), map[string][]string{"panel-b.example": {"198.51.100.9"}})

	pass(t, r)
	if got := store.Record("panel-b"); got.ReviewState != driver.ReviewAccepted {
		t.Fatalf("B = %s, want accepted", got.ReviewState)
	}
	if a.TotalCalls() != 0 {
		t.Fatalf("A was called %d times for a panel nothing links to it", a.TotalCalls())
	}
}

func TestTheSameIPIsASuspectEvenWithOtherInbounds(t *testing.T) {
	same := fake.New(fake.Config{})
	holder := registered("203.0.113.1")
	holder.Inbounds = []register.InboundKey{{RemoteID: "9", Port: 2053, Protocol: "trojan"}}
	r, store := dupSetup(same, same, holder, map[string][]string{"panel-b.example": {"203.0.113.1"}})

	pass(t, r)
	if got := store.Record("panel-b"); got.DuplicateOf != holderID {
		t.Fatalf("B = %s duplicate of %q, want a duplicate of %s", got.ReviewState, got.DuplicateOf, holderID)
	}
}

func TestACanaryThatCannotBeMadeHoldsThePanelPending(t *testing.T) {
	a := fake.New(fake.Config{Unsupported: map[driver.RowKey]bool{driver.RowClientLifecycle: true}})
	b := fake.New(fake.Config{})
	r, store := dupSetup(a, b, registered(""), nil)

	report := pass(t, r)
	got := store.Record("panel-b")
	if got.ReviewState != driver.ReviewPending || got.Fault == "" {
		t.Fatalf("B = %s fault %q, want pending with a fault", got.ReviewState, got.Fault)
	}
	if !strings.Contains(got.Detail, "de-fra-1") || len(report.Failed) != 1 {
		t.Fatalf("detail %q (failed %d): must name the suspect", got.Detail, len(report.Failed))
	}
}

func TestAPanelsOwnClaimTagsAreNotAnotherPanels(t *testing.T) {
	a, b := fake.New(fake.Config{Inbounds: []driver.Inbound{{RemoteID: "x", Protocol: "vmess", Port: 1, Enabled: true}}}), fake.New(fake.Config{})
	if _, err := b.CreateClient(context.Background(), driver.CreateClientRequest{ClaimTag: "ct-own", UUID: "u-own", InboundRemoteID: "inbound-1", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	holder := registered("")
	holder.Inbounds = []register.InboundKey{{RemoteID: "x", Port: 1, Protocol: "vmess"}}
	r, store := dupSetup(a, b, holder, nil)
	store.Claim("panel-b", "ct-own", "u-own") // B re-tested after an address edit

	pass(t, r)
	if got := store.Record("panel-b"); got.ReviewState != driver.ReviewAccepted {
		t.Fatalf("B = %s duplicate of %q, want accepted: its own configs are not a duplicate", got.ReviewState, got.DuplicateOf)
	}
}

// F-027-fi (user 2026-10-26, LIVE-1): a suspect whose anchor stands — planted,
// and no open drift event halting it — is not canaried. The new panel's client
// list was already searched for every anchor (rule 6); its absence there is the
// answer. Eleven panels behind one IP each took a canary per registration,
// serially inside one deadline, and none could be accepted.
func TestASuspectWhoseAnchorStandsGetsNoCanary(t *testing.T) {
	a, b := fake.New(fake.Config{}), fake.New(fake.Config{}) // same inbound set, two servers
	plant(t, a, "anchor-a", "u-anchor-a")
	holder := registered("")
	holder.Anchor = anchor.Anchor{Tag: "anchor-a", UUID: "u-anchor-a", RemoteID: "1"}
	r, store := dupSetup(a, b, holder, nil)
	planted := a.CallCount("CreateClient")

	pass(t, r)
	if got := store.Record("panel-b"); got.ReviewState != driver.ReviewAccepted || got.DuplicateOf != "" {
		t.Fatalf("B = %s duplicate of %q, want accepted", got.ReviewState, got.DuplicateOf)
	}
	if a.CallCount("CreateClient") != planted {
		t.Fatal("A's anchor is not on B: that is the answer, no canary on A")
	}
}

// A halted suspect's anchor is not known to stand (identity_lost is exactly a
// missing anchor), so it still gets the canary — and a copy is still found.
func TestAHaltedSuspectStillGetsTheCanary(t *testing.T) {
	same := fake.New(fake.Config{}) // one panel, two rows; its anchor was deleted
	holder := registered("")
	holder.Anchor = anchor.Anchor{Tag: "anchor-a", UUID: "u-anchor-a", RemoteID: "1"}
	holder.Halted = true
	r, store := dupSetup(same, same, holder, nil)

	pass(t, r)
	if got := store.Record("panel-b"); got.ReviewState != driver.ReviewRefused || got.DuplicateOf != holderID {
		t.Fatalf("B = %s duplicate of %q, want refused as a duplicate of %s", got.ReviewState, got.DuplicateOf, holderID)
	}
}

// Suspects with no standing anchor are canaried side by side, so the check's
// deadline bounds the slowest one, not their sum.
func TestCanariesOnSeveralSuspectsRunSideBySide(t *testing.T) {
	const stall = 200 * time.Millisecond
	a, c, b := fake.New(fake.Config{}), fake.New(fake.Config{}), fake.New(fake.Config{})
	r, store, _ := setup(map[string]driver.Driver{holderID: a, "panel-c": c, "panel-b": b}, pending("panel-b", driver.TransportPull, driver.CounterCumulative))
	r.Timeout = 300 * time.Millisecond // one stall fits; two in a row do not
	store.PutRegistered(registered(""), driver.ReviewAccepted)
	other := registered("")
	other.Pending = pending("panel-c", driver.TransportPull, driver.CounterCumulative)
	store.PutRegistered(other, driver.ReviewAccepted)
	a.StallNextCall(stall)
	c.StallNextCall(stall)

	pass(t, r)
	if got := store.Record("panel-b"); got.ReviewState != driver.ReviewAccepted {
		t.Fatalf("B = %s fault %q (%s), want accepted inside one deadline", got.ReviewState, got.Fault, got.Detail)
	}
	if a.CallCount("CreateClient") != 1 || c.CallCount("CreateClient") != 1 {
		t.Fatalf("canaries: A %d, C %d; want one each", a.CallCount("CreateClient"), c.CallCount("CreateClient"))
	}
}
