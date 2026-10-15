package collect_test

import (
	"context"
	"net/netip"
	"slices"
	"testing"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/egress"
)

// A domain address is pinned to the IPs it was accepted at (F-027-ez,
// ADR-0130 decision 4). Each turn resolves the host once; the panel's driver
// dials only what that turn checked. What would break silently:
//
//   - the login sent to whatever the domain resolves to this minute — a
//     re-pointed or stolen domain receives it;
//   - a second lookup between the check and the dial (DNS rebinding);
//   - a panel behind a CDN halted every few minutes: `addressMayMove` skips it;
//   - a panel accepted before this has nothing to compare: it learns.

var (
	knownIP = netip.MustParseAddr("203.0.113.1")
	movedIP = netip.MustParseAddr("198.51.100.7")
)

type addressRig struct {
	panel    *fake.Panel
	loop     *collect.Loop
	pin      *egress.Pin
	book     *collect.MemoryAddresses
	events   *collect.MemoryDriftEvents
	resolved []netip.Addr
	lookups  int
}

func newAddressRig(t *testing.T, known []netip.Addr, mayMove bool) *addressRig {
	t.Helper()
	r := &addressRig{
		panel: fake.New(fake.Config{CounterSemantics: driver.CounterCumulative}), pin: egress.NewPin(),
		book: collect.NewMemoryAddresses(), events: collect.NewMemoryDriftEvents(),
	}
	r.panel.Given("c1")
	r.loop = &collect.Loop{
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) {
			return []collect.Panel{{
				ID: "panel-1", Host: "panel-1.example", CounterSemantics: driver.CounterCumulative,
				Transport: driver.TransportPull, MaxLineRateBps: gigabit, Driver: r.panel, ReviewState: driver.ReviewAccepted,
				Configs: map[string]collect.ConfigRef{"c1": {ConfigID: "config-c1", Protocol: "vless"}},
				Address: collect.Address{Known: r.book.Of("panel-1", known), MayMove: mayMove, Pin: r.pin},
			}}, nil
		}),
		Sink: &recorder{}, Cursors: collect.NewMemoryCursors(), Addresses: r.book,
		Containment: &collect.Containment{Events: r.events},
		Resolve: func(_ context.Context, host string) ([]netip.Addr, error) {
			r.lookups++
			return r.resolved, nil
		},
	}
	return r
}

func (r *addressRig) pass(t *testing.T) {
	t.Helper()
	if _, err := r.loop.Pass(context.Background()); err != nil {
		t.Fatalf("Pass: %v", err)
	}
}

func TestAKnownAddressIsTheOneDialed(t *testing.T) {
	r := newAddressRig(t, []netip.Addr{knownIP}, false)
	r.resolved = []netip.Addr{movedIP, knownIP} // a second record beside ours

	r.pass(t)
	if got := r.pin.Addrs(); !slices.Equal(got, []netip.Addr{knownIP}) {
		t.Fatalf("pinned %v, want only the known %v", got, knownIP)
	}
	if r.panel.CallCount("GetUsage") != 1 || len(r.events.Events("panel-1")) != 0 {
		t.Fatalf("read %d times with events %+v, want read once, no event", r.panel.CallCount("GetUsage"), r.events.Events("panel-1"))
	}
	if r.lookups != 1 {
		t.Fatalf("resolved %d times in one turn, want once", r.lookups)
	}
}

func TestNoKnownAddressMeansNoLoginAndAHaltNamingBoth(t *testing.T) {
	r := newAddressRig(t, []netip.Addr{knownIP}, false)
	r.resolved = []netip.Addr{movedIP}

	r.pass(t)
	r.pass(t) // halted: not asked again until acknowledged
	if n := r.panel.TotalCalls(); n != 0 {
		t.Fatalf("the panel was called %d times; the login must not be sent", n)
	}
	if got := r.pin.Addrs(); len(got) != 0 {
		t.Fatalf("pinned %v, want nothing dialable", got)
	}
	got := r.events.Events("panel-1")
	if len(got) != 1 || got[0].Type != collect.AddressMoved || !got[0].CollectionHalted ||
		!slices.Equal(got[0].KnownAddresses, []string{knownIP.String()}) || !slices.Equal(got[0].SeenAddresses, []string{movedIP.String()}) {
		t.Fatalf("events %+v, want one halting address_moved naming %v and %v", got, knownIP, movedIP)
	}
	if collect.AddressMoved.Converges() {
		t.Fatal("a moved address is converged: the login would be sent")
	}
}

func TestAPanelThatMayMoveIsDialedWhereItResolves(t *testing.T) {
	r := newAddressRig(t, []netip.Addr{knownIP}, true)
	r.resolved = []netip.Addr{movedIP}

	r.pass(t)
	if got := r.pin.Addrs(); !slices.Equal(got, []netip.Addr{movedIP}) || len(r.events.Events("panel-1")) != 0 {
		t.Fatalf("pinned %v with events %+v, want %v and no event", got, r.events.Events("panel-1"), movedIP)
	}
}

func TestAPanelWithNoKnownAddressLearnsIt(t *testing.T) {
	r := newAddressRig(t, nil, false)
	r.resolved = []netip.Addr{knownIP}

	r.pass(t)
	r.resolved = []netip.Addr{movedIP}
	r.pass(t)
	if got := r.book.Of("panel-1", nil); !slices.Equal(got, []netip.Addr{knownIP}) {
		t.Fatalf("learned %v, want %v and never relearned", got, knownIP)
	}
	if got := r.events.Events("panel-1"); len(got) != 1 || got[0].Type != collect.AddressMoved {
		t.Fatalf("events %+v, want the move after learning raised", got)
	}
}
