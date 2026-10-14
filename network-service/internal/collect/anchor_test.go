package collect_test

import (
	"context"
	"testing"

	"network-service/internal/anchor"
	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// A panel accepted before anchors existed gets one on its first pass
// (F-027-ew, ADR-0130 decision 1), and the anchor is never billed. What would
// break silently: a panel left with nothing to know its server by, a second
// anchor beside the first, and the anchor's bytes written down as usage.

func anchorRig(t *testing.T) (*fake.Panel, *collect.Loop, *collect.MemoryAnchors, *recorder) {
	p, loop, anchors, sink, _ := identityRig(t)
	return p, loop, anchors, sink
}

func identityRig(t *testing.T) (*fake.Panel, *collect.Loop, *collect.MemoryAnchors, *recorder, *collect.MemoryDriftEvents) {
	t.Helper()
	p := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	p.Given("c1")
	anchors := collect.NewMemoryAnchors()
	events := collect.NewMemoryDriftEvents()
	sink := &recorder{}
	loop := &collect.Loop{
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) {
			return []collect.Panel{{
				ID: "panel-1", CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull,
				MaxLineRateBps: gigabit, Driver: p, ReviewState: driver.ReviewAccepted,
				Configs: map[string]collect.ConfigRef{"c1": {ConfigID: "config-c1", Protocol: "vless"}},
				Anchor:  anchors.Of("panel-1"), // what the next pass's read of the row holds
			}}, nil
		}),
		Sink: sink, Cursors: collect.NewMemoryCursors(), Anchors: anchors,
		Containment: &collect.Containment{Events: events},
	}
	return p, loop, anchors, sink, events
}

func TestAPanelAcceptedBeforeAnchorsGetsOneOnItsFirstPass(t *testing.T) {
	p, loop, anchors, _ := anchorRig(t)

	for range 2 {
		if _, err := loop.Pass(context.Background()); err != nil {
			t.Fatalf("Pass: %v", err)
		}
	}
	a := anchors.Of("panel-1")
	clients, _ := p.ListClients(context.Background())
	if !a.Planted() || len(clients) != 2 || p.CallCount("CreateClient") != 1 {
		t.Fatalf("anchor %+v, %d clients, %d creates; want one anchor beside c1, planted once", a, len(clients), p.CallCount("CreateClient"))
	}
	if c, ok := a.In(clients); !ok || c.Enabled || c.DataLimitBytes != 1 {
		t.Fatalf("anchor on the panel = %+v, want disabled under 1 byte", c)
	}
}

func TestTheAnchorIsNeverBilled(t *testing.T) {
	p, loop, anchors, sink := anchorRig(t)
	ctx := context.Background()
	if _, err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	p.Serve(anchors.Of("panel-1").RemoteID, 0, 1) // the byte its limit allows
	p.Serve("c1", 0, gb)
	if _, err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	res := sink.last(t)
	if len(res.Unattributed) != 0 || len(res.Deltas) != 1 || res.Deltas[0].RemoteID != "c1" {
		t.Fatalf("deltas %+v, unattributed %+v; want c1's only", res.Deltas, res.Unattributed)
	}
}

func TestABackfillThatLostTheRaceTakesItsAnchorBack(t *testing.T) {
	p, loop, anchors, _ := anchorRig(t)
	anchors.Lose("panel-1", anchor.Anchor{Tag: "anchor-other", UUID: "u", RemoteID: "r"})

	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	clients, _ := p.ListClients(context.Background())
	if len(clients) != 1 || anchors.Of("panel-1").Tag != "anchor-other" {
		t.Fatalf("%d clients, anchor %+v; want ours deleted and the recorded one kept", len(clients), anchors.Of("panel-1"))
	}
}

// Every pass looks for the anchor first (F-027-ex, ADR-0130 decision 2). What
// would break silently: an address re-pointed to an empty or reinstalled
// server read as ours and every config recreated there; one re-pointed to a
// registered panel with no configs converged onto a server not its own.

func TestAPanelWhoseAnchorIsGoneIsHaltedBeforeAnythingIsRead(t *testing.T) {
	p, loop, anchors, sink, events := identityRig(t)
	ctx := context.Background()
	if _, err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	p.Remove(anchors.Of("panel-1").RemoteID) // reinstalled: our clients are gone
	p.Remove("c1")
	reads, creates := p.CallCount("GetUsage"), p.CallCount("CreateClient")

	for range 2 {
		if _, err := loop.Pass(ctx); err != nil {
			t.Fatal(err)
		}
	}
	got := events.Events("panel-1")
	if len(got) != 1 || got[0].Type != collect.IdentityLost || !got[0].CollectionHalted || got[0].ForeignPanelID != "" {
		t.Fatalf("events %+v, want one halting identity_lost naming no panel", got)
	}
	if p.CallCount("GetUsage") != reads || p.CallCount("CreateClient") != creates || len(sink.results) != 1 {
		t.Fatal("a panel that lost its identity was read, written or published")
	}
	if collect.IdentityLost.Converges() {
		t.Fatal("identity_lost converges: the missing configs would be recreated on a stranger")
	}
}

func TestAnotherPanelsAnchorIsAForeignClaimNamingIt(t *testing.T) {
	p, loop, anchors, _, events := identityRig(t)
	ctx := context.Background()
	if _, err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	ours := anchors.Of("panel-1")
	p.Remove(ours.RemoteID)
	theirs, err := anchor.Plant(ctx, p) // the server is panel-2's, which has no configs
	if err != nil {
		t.Fatal(err)
	}
	anchors.Put("panel-2", theirs)
	reads := p.CallCount("GetUsage")

	if _, err := loop.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	got := events.Events("panel-1")
	if len(got) != 1 || got[0].Type != collect.ForeignClaim || got[0].ForeignPanelID != "panel-2" || !got[0].CollectionHalted {
		t.Fatalf("events %+v, want a halting foreign_claim naming panel-2", got)
	}
	if p.CallCount("GetUsage") != reads {
		t.Fatal("the panel was read past another panel's anchor")
	}
}

func TestOurOwnAnchorLetsThePassGoOn(t *testing.T) {
	p, loop, _, sink, events := identityRig(t)
	ctx := context.Background()
	for range 2 {
		if _, err := loop.Pass(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(events.Events("panel-1")) != 0 || len(sink.results) != 2 || p.CallCount("GetUsage") != 2 {
		t.Fatalf("events %+v, %d published; want none raised and both passes read", events.Events("panel-1"), len(sink.results))
	}
}
