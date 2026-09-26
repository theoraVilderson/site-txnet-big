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

// F-111-n: a Grant activates on the panels' word (network contract.groups.md
// rule 10), and that word is the read that finds a written client holding
// its desired state. The read is announced, so billing activates the Grant at
// once, and it is asked for ~2s after the write instead of on the next
// minute's pass.

func TestTheReadThatConfirmsACreatedClientIsAnnouncedOnce(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.desired.Put("panel-1", wanted("c1"))

	r.pass(t) // the create: partial, nothing confirmed yet
	if got := r.desired.Confirmed(); len(got) != 0 {
		t.Fatalf("confirmed after the create = %v, want none: a write is not the panel's word", got)
	}
	r.pass(t) // the read that finds it
	if got := r.desired.Confirmed(); len(got) != 1 || got[0] != "c1" {
		t.Fatalf("confirmed after the read = %v, want [c1]", got)
	}
	r.pass(t) // still complete: nothing new to say
	if got := r.desired.Confirmed(); len(got) != 1 {
		t.Fatalf("confirmed after a pass that changed nothing = %v, want still [c1]", got)
	}
}

func TestAConfirmedDeleteIsNotAnnounced(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.panel.Given("remote-a")
	row := wanted("c1")
	row.RemoteID, row.UUID, row.Present, row.Enabled = "remote-a", "remote-a", false, false
	r.desired.Put("panel-1", row)

	r.pass(t)
	r.pass(t)
	if got := r.row(t, "c1"); got.State != converge.StateComplete {
		t.Fatalf("state = %q, want the delete confirmed", got.State)
	}
	if got := r.desired.Confirmed(); len(got) != 0 {
		t.Fatalf("confirmed = %v, want none: a gone client serves nobody", got)
	}
}

func TestAPassThatWroteAsksForAConfirmingReadAndNoOtherDoes(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	var asked []string
	r.conv.Confirm = func(_ context.Context, panelID string) { asked = append(asked, panelID) }
	p := collect.Panel{ID: "panel-1", CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull, MaxLineRateBps: gigabit, Driver: r.panel}
	converge1 := func(confirming bool) {
		t.Helper()
		r.at = r.at.Add(time.Second)
		if err := r.conv.Converge(context.Background(), p, collect.Result{PanelID: p.ID, ObservedAt: r.at, Confirming: confirming}); err != nil {
			t.Fatalf("Converge: %v", err)
		}
	}

	r.desired.Put("panel-1", wanted("c1"))
	converge1(false) // the create
	if len(asked) != 1 || asked[0] != "panel-1" {
		t.Fatalf("asked = %v after a create, want one confirming read of panel-1", asked)
	}
	converge1(true) // the confirming read writes nothing
	converge1(false)
	if len(asked) != 1 {
		t.Fatalf("asked = %v, want no read asked for by a pass that wrote nothing", asked)
	}

	// A confirming turn that wrote does not ask again: a panel that never
	// holds what we write is left to the minute pass, not read every 2s.
	r.desired.Put("panel-1", wanted("c2"))
	converge1(true)
	if len(asked) != 1 {
		t.Fatalf("asked = %v, want a confirming turn never to ask for another", asked)
	}
}
