package converge_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// F-027-fj (user 2026-10-27, LIVE-1): a turn creates at most MaxCreates
// clients. A migration's 1600 creates on one Marzban (~2 s each) ran inside
// one collection turn for an hour, and the bulk pass waits for every turn, so
// no panel of any reseller was collected meanwhile. What is left is deferred:
// the converger owes the panel more turns, and the waker runs them.

// owed records each panel the converger asked another turn for.
type owed []string

func (o *owed) owe(_ context.Context, panelID string) { *o = append(*o, panelID) }

func TestATurnCreatesAtMostItsBudgetAndOwesThePanelTheRest(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.conv.Provisioning.MaxWrites = 10
	var asked owed
	r.conv.Owe = asked.owe
	for i := 0; i < 15; i++ {
		r.desired.Put("panel-1", wanted(fmt.Sprintf("c%02d", i)))
	}

	r.converge(t)
	if n := r.clients(t); n != 10 {
		t.Fatalf("the panel holds %d clients after one turn, want the budget's 10", n)
	}
	if len(asked) != 1 || asked[0] != "panel-1" {
		t.Fatalf("turns owed = %v, want one for panel-1", asked)
	}

	r.converge(t)
	if n := r.clients(t); n != 15 {
		t.Fatalf("the panel holds %d clients after the owed turn, want all 15", n)
	}
	if len(asked) != 1 {
		t.Fatalf("a turn that deferred nothing owed another: %v", asked)
	}
}

// A cut-off is a disable: it never waits behind a backlog of creates.
func TestADisableIsNeverDeferredBehindCreates(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.conv.Provisioning.MaxWrites = 2
	for i := 0; i < 5; i++ {
		r.desired.Put("panel-1", wanted(fmt.Sprintf("c%02d", i)))
	}
	r.panel.Given("remote-z")
	cut := wanted("z-cut") // after every create in the turn's order
	cut.RemoteID, cut.UUID, cut.Enabled = "remote-z", "remote-z", false
	r.desired.Put("panel-1", cut)

	report := r.pass(t)
	if report.Deferred != 3 {
		t.Fatalf("deferred %d, want 3 of the 5 creates", report.Deferred)
	}
	if client, _ := r.client(t, "remote-z"); client.Enabled {
		t.Fatal("the cut-off waited behind the creates")
	}
}

// A client made again (a repair) is a create, and spends the same budget.
func TestARecreateSpendsTheCreateBudget(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.conv.Provisioning.MaxWrites = 1
	for _, id := range []string{"c1", "c2"} {
		row := wanted(id)
		row.RemoteID = "gone-" + id // ours, and no longer on the panel
		r.desired.Put("panel-1", row)
	}

	if report := r.pass(t); report.Written != 1 || report.Deferred != 1 {
		t.Fatalf("wrote %d, deferred %d; want one recreate and one deferred", report.Written, report.Deferred)
	}
}

// converge runs one turn the way the loop does — Converge, not Pass — so the
// owed turn is asked for.
func (r *provRig) converge(t *testing.T) {
	t.Helper()
	r.at = r.at.Add(time.Minute)
	p := collect.Panel{ID: "panel-1", CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull, MaxLineRateBps: gigabit, Driver: r.panel}
	if err := r.conv.Converge(context.Background(), p, collect.Result{ObservedAt: r.at}); err != nil {
		t.Fatalf("converge: %v", err)
	}
}

func (r *provRig) clients(t *testing.T) int {
	t.Helper()
	clients, err := r.panel.ListClients(context.Background())
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	return len(clients)
}

// A count alone does not bound a turn: on the LIVE-1 node a Marzban of 1100
// users took 4–9 s a create, so ten held the panel's lock — and the bulk pass —
// for 45–95 s. Creates also stop once CreateWindow has passed since the
// turn's first one; the first is always made, so a backlog always moves.
func TestATurnStopsCreatingOnceItsWindowHasPassed(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.conv.Provisioning.MaxWrites = 10
	r.conv.Provisioning.WriteWindow = 10 * time.Second
	at := time.Date(2026, 10, 27, 6, 30, 0, 0, time.UTC)
	r.conv.Provisioning.Now = func() time.Time { at = at.Add(4 * time.Second); return at } // each create costs 4 s
	for i := 0; i < 6; i++ {
		r.desired.Put("panel-1", wanted(fmt.Sprintf("c%02d", i)))
	}

	if report := r.pass(t); report.Writes != 3 || report.Deferred != 3 {
		t.Fatalf("created %d, deferred %d; want 3 inside 10 s and 3 deferred", report.Writes, report.Deferred)
	}
}

// F-027-fk (user 2026-10-28, LIVE-1): a delete is as slow as a create. A move
// left 350 deletes on one Marzban; one turn tried them all, the first timed
// out, the breaker opened, and the panel's usage went unread. Deletes spend
// the same budget, and what is left is owed the same woken turns.
func TestADeleteSpendsTheWriteBudget(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.conv.Provisioning.MaxWrites = 10
	var asked owed
	r.conv.Owe = asked.owe
	for i := 0; i < 15; i++ {
		id := fmt.Sprintf("old-%02d", i)
		r.panel.Given(id)
		row := wanted(id)
		row.RemoteID, row.UUID, row.Present = id, id, false // moved away: the client goes
		r.desired.Put("panel-1", row)
	}

	r.converge(t)
	if n := r.clients(t); n != 5 {
		t.Fatalf("%d clients left after one turn, want 5: ten deletes, five deferred", n)
	}
	if len(asked) != 1 {
		t.Fatalf("turns owed = %v, want one", asked)
	}
}

// A panel that stops answering mid-turn is not written to again in that turn:
// the rest are left for the next pass instead of failing one by one into an
// open breaker, and no woken turn is asked — a panel that is down is the bulk
// pass's to retry.
func TestATurnStopsWritingOnceThePanelStopsAnswering(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	var asked owed
	r.conv.Owe = asked.owe
	for i := 0; i < 5; i++ {
		r.desired.Put("panel-1", wanted(fmt.Sprintf("c%02d", i)))
	}
	r.panel.FailOp("CreateClient", 504, 0) // a gateway timeout: no answer

	report := r.pass(t)
	if calls := r.panel.CallCount("CreateClient"); calls != 1 {
		t.Fatalf("%d creates tried against a panel that stopped answering, want 1", calls)
	}
	if !report.Stalled || report.Failed != 1 {
		t.Fatalf("stalled %v, failed %d; want stalled after the one failure", report.Stalled, report.Failed)
	}
	r.converge(t)
	if len(asked) != 0 {
		t.Fatalf("a stalled turn owed %v, want none", asked)
	}
}

// One client the panel refuses is that row's failure, not the panel's: a 500
// with a status leaves the turn writing, or the same row, first on every pass,
// would block the panel's every later write for good.
func TestOneRefusedClientDoesNotStopTheTurn(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	for i := 0; i < 3; i++ {
		r.desired.Put("panel-1", wanted(fmt.Sprintf("c%02d", i)))
	}
	r.panel.FailOp("CreateClient", 500, 1)

	report := r.pass(t)
	if report.Stalled || report.Failed != 1 || r.clients(t) != 2 {
		t.Fatalf("stalled %v, failed %d, clients %d; want the other two created", report.Stalled, report.Failed, r.clients(t))
	}
}
