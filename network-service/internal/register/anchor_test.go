package register_test

import (
	"context"
	"strings"
	"testing"

	"network-service/internal/anchor"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// A pull panel carries an anchor (F-027-ew, ADR-0130 decisions 1 and 3): the
// connection test that would take it plants one disabled client — a 1-byte
// limit, no expiry, a random `anchor-` tag and uuid — and the verdict records
// it. What would break silently:
//
//   - a panel accepted with nothing to know its server by;
//   - an anchor planted and not recorded (a stale answer): an orphan of ours;
//   - a family that cannot make one accepted anyway (registration.md rule 9);
//   - a re-test planting a second anchor beside the one already there;
//   - two pending registrations of one server both passing: the check and the
//     planting run under one lock.

func TestAnAcceptedPullPanelCarriesItsAnchor(t *testing.T) {
	panel := fake.New(fake.Config{})
	r, store, _ := setup(map[string]driver.Driver{"p1": panel}, pending("p1", driver.TransportPull, driver.CounterCumulative))

	pass(t, r)
	got := store.Record("p1")
	if got.ReviewState != driver.ReviewAccepted || !got.Anchor.Planted() {
		t.Fatalf("p1 = %s with anchor %+v, want accepted carrying one", got.ReviewState, got.Anchor)
	}
	client, ok := got.Anchor.In(clientsOf(t, panel))
	if !ok || client.Enabled || client.DataLimitBytes != 1 || !client.ExpiresAt.IsZero() ||
		!strings.HasPrefix(client.Label, anchor.TagPrefix) || client.RemoteID != got.Anchor.RemoteID {
		t.Fatalf("anchor on the panel = %+v (found %v), want disabled, 1 byte, no expiry, recorded as %+v", client, ok, got.Anchor)
	}
	if store.LockRuns() != 1 {
		t.Fatalf("the check and the planting ran under the lock %d times, want once", store.LockRuns())
	}
}

func TestAPushPanelAndARefusedOneCarryNoAnchor(t *testing.T) {
	push := fake.New(fake.Config{Transport: driver.TransportPush, CounterSemantics: driver.CounterSession})
	refused := fake.New(fake.Config{Unsupported: map[driver.RowKey]bool{driver.RowEnableDisableClient: true}})
	r, store, _ := setup(map[string]driver.Driver{"push": push, "no": refused},
		pending("push", driver.TransportPush, driver.CounterSession),
		pending("no", driver.TransportPull, driver.CounterCumulative))

	pass(t, r)
	for _, id := range []string{"push", "no"} {
		if got := store.Record(id); got.Anchor.Planted() {
			t.Errorf("%s (%s) carries anchor %+v, want none", id, got.ReviewState, got.Anchor)
		}
	}
	if push.CallCount("CreateClient")+refused.CallCount("CreateClient") != 0 {
		t.Fatal("a client was created on a panel that is not taken")
	}
}

// cannotCreate is a family whose create fails: the canary's create path, so
// the anchor's too.
type cannotCreate struct{ driver.Driver }

func (cannotCreate) CreateClient(context.Context, driver.CreateClientRequest) (driver.RemoteClient, error) {
	return driver.RemoteClient{}, &driver.Fault{Kind: driver.FaultProtocol, Op: "CreateClient"}
}

func TestAFamilyThatCannotPlantAnAnchorStaysPending(t *testing.T) {
	r, store, _ := setup(map[string]driver.Driver{"p1": cannotCreate{fake.New(fake.Config{})}},
		pending("p1", driver.TransportPull, driver.CounterCumulative))

	pass(t, r)
	got := store.Record("p1")
	if got.ReviewState != driver.ReviewPending || got.Fault == "" || !strings.Contains(got.Detail, "anchor") {
		t.Fatalf("p1 = %s fault %q detail %q, want pending with a fault naming the anchor", got.ReviewState, got.Fault, got.Detail)
	}
}

func TestARetestKeepsTheAnchorAlreadyOnThePanel(t *testing.T) {
	panel := fake.New(fake.Config{})
	r, store, _ := setup(map[string]driver.Driver{"p1": panel}, pending("p1", driver.TransportPull, driver.CounterCumulative))
	pass(t, r)
	first := store.Record("p1").Anchor

	store.Edit("p1", "https://p1-new.example", "") // the same server under a new address
	pass(t, r)
	if got := store.Record("p1").Anchor; got != first || len(clientsOf(t, panel)) != 1 {
		t.Fatalf("re-test anchor %+v over %d clients, want %+v kept and no second one", got, len(clientsOf(t, panel)), first)
	}
}

func TestAnAnchorWhoseAnswerIsStaleIsTakenBack(t *testing.T) {
	panel := fake.New(fake.Config{})
	r, store, _ := setup(map[string]driver.Driver{"p1": panel}, pending("p1", driver.TransportPull, driver.CounterCumulative))
	store.BeforeAnswer = func() { store.Decide("p1", driver.ReviewRefused) } // withdrawn mid-test

	report := pass(t, r)
	if report.Stale != 1 || len(clientsOf(t, panel)) != 0 {
		t.Fatalf("stale %d, %d clients left, want the answer dropped and the anchor deleted", report.Stale, len(clientsOf(t, panel)))
	}
}

func clientsOf(t *testing.T, p *fake.Panel) []driver.RemoteClient {
	t.Helper()
	clients, err := p.ListClients(context.Background())
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	return clients
}
