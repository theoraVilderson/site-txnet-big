package register_test

import (
	"context"
	"strings"
	"testing"

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
//   - a copy that already carries our clients passing as new: a claim tag (or
//     Xray uuid) of another panel's config on it names that panel;
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
	r.Resolve = func(_ context.Context, host string) ([]string, error) { return resolve[host], nil }
	return r, store
}

func TestAPanelCarryingAnotherPanelsClaimTagIsThatPanel(t *testing.T) {
	a, b := fake.New(fake.Config{}), fake.New(fake.Config{})
	if _, err := b.CreateClient(context.Background(), driver.CreateClientRequest{ClaimTag: "ct-42", UUID: "u-42", InboundRemoteID: "inbound-1", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	r, store := dupSetup(a, b, registered(""), nil)
	store.Claim(holderID, "ct-42", "u-42")

	pass(t, r)
	got := store.Record("panel-b")
	if got.ReviewState != driver.ReviewRefused || got.DuplicateOf != holderID {
		t.Fatalf("B = %s duplicate of %q, want refused as a duplicate of %s", got.ReviewState, got.DuplicateOf, holderID)
	}
	if a.CallCount("CreateClient") != 0 {
		t.Fatal("a claim tag is proof enough: no canary")
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
