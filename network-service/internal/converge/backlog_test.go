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
	r.conv.Provisioning.MaxCreates = 10
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
	r.conv.Provisioning.MaxCreates = 2
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
	r.conv.Provisioning.MaxCreates = 1
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
