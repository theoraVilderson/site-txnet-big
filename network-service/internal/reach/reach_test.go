package reach_test

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"syscall"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/reach"
)

var at = time.Date(2026, 10, 6, 6, 0, 0, 0, time.UTC)

type observed struct {
	id  string
	err error
	at  time.Time
}

type inner struct{ got []observed }

func (i *inner) Ask(string, time.Time) bool { return true }
func (i *inner) Observe(_ context.Context, id string, err error, when time.Time) error {
	i.got = append(i.got, observed{id, err, when})
	return nil
}

type probe struct {
	res   reach.Probe
	calls int
}

func (p *probe) Check(context.Context) reach.Probe { p.calls++; return p.res }

type beats struct{ got []reach.Beat }

func (b *beats) Beat(_ context.Context, beat reach.Beat) error {
	b.got = append(b.got, beat)
	return nil
}

func refused() error {
	return driver.NewFault(driver.FaultUnavailable, "GetUsage", 0,
		fmt.Errorf("dial: %w", os.NewSyscallError("connect", syscall.ECONNREFUSED)))
}

func unresolved() error {
	return driver.NewFault(driver.FaultUnavailable, "GetUsage", 0, fmt.Errorf("lookup: %w", &net.DNSError{Err: "no such host", Name: "a.example", IsNotFound: true}))
}

func gate(p *probe) (*reach.Gate, *inner, *beats) {
	in, b := &inner{}, &beats{}
	return &reach.Gate{Inner: in, Probe: p, Heartbeats: b, Instance: "collector-1", StartedAt: at}, in, b
}

func refs(hosts ...string) []reach.PanelRef {
	out := make([]reach.PanelRef, len(hosts))
	for i, h := range hosts {
		out[i] = reach.PanelRef{ID: fmt.Sprintf("p%d", i), Host: h}
	}
	return out
}

// The panel spoke, so nothing on our side produced the answer: it is judged
// at once, and no probe is spent on it (ADR-0122 point 2).
func TestAnAnswerIsThePanelsAtOnce(t *testing.T) {
	p := &probe{res: reach.Probe{TCP: true, DNS: true}}
	g, in, _ := gate(p)
	g.BeginPass(refs("a.example"))
	_ = g.Observe(context.Background(), "p0", driver.FaultForStatus("GetUsage", http.StatusUnauthorized, nil), at)
	_ = g.Observe(context.Background(), "p0", nil, at)
	if len(in.got) != 2 {
		t.Fatalf("forwarded %d of 2 answers before the pass ended", len(in.got))
	}
	if err := g.EndPass(context.Background(), at); err != nil {
		t.Fatal(err)
	}
	if p.calls != 0 {
		t.Fatalf("probed %d times on a pass with no network failure", p.calls)
	}
}

// A network-layer failure waits for the pass: only once our own reach is
// proven is it the panel's, with the moment it was seen.
func TestANetworkFailureIsThePanelsOnceOurReachIsProven(t *testing.T) {
	p := &probe{res: reach.Probe{TCP: true, DNS: true}}
	g, in, _ := gate(p)
	g.BeginPass(refs("a.example", "b.example"))
	_ = g.Observe(context.Background(), "p0", refused(), at)
	_ = g.Observe(context.Background(), "p1", nil, at)
	if len(in.got) != 1 {
		t.Fatalf("the network failure was forwarded before our reach was known: %+v", in.got)
	}
	_ = g.EndPass(context.Background(), at.Add(time.Second))
	if len(in.got) != 2 || in.got[1].id != "p0" || !in.got[1].at.Equal(at) {
		t.Fatalf("forwarded %+v", in.got)
	}
}

// The user's requirement: when our server cannot reach anything, no panel is
// blamed. The failures are frozen, and the heartbeat says the egress is down.
func TestOurEgressDownFreezesEveryNetworkFailure(t *testing.T) {
	p := &probe{res: reach.Probe{TCP: false, DNS: true}}
	g, in, b := gate(p)
	g.BeginPass(refs("a.example", "b.example"))
	_ = g.Observe(context.Background(), "p0", refused(), at)
	_ = g.Observe(context.Background(), "p1", driver.FaultForStatus("GetUsage", http.StatusBadGateway, nil), at)
	_ = g.EndPass(context.Background(), at)

	for _, o := range in.got {
		if o.id == "p0" {
			t.Fatal("a panel was blamed for our own egress outage")
		}
	}
	if len(in.got) != 1 {
		t.Fatalf("the 502 — an answer — must still be judged: %+v", in.got)
	}
	if last := b.got[len(b.got)-1]; last.Egress != reach.EgressDown || !last.EgressSince.Equal(at) {
		t.Fatalf("heartbeat %+v", last)
	}

	// Still down a pass later: the clock is when it started.
	g.BeginPass(refs("a.example"))
	_ = g.Observe(context.Background(), "p0", refused(), at.Add(time.Minute))
	_ = g.EndPass(context.Background(), at.Add(time.Minute))
	if last := b.got[len(b.got)-1]; !last.EgressSince.Equal(at) {
		t.Fatalf("egressSince restarted: %v", last.EgressSince)
	}
}

// A dead resolver is ours for names only: a panel that refused our dial on
// its IP is still the panel's.
func TestOurResolverDownFreezesOnlyNameFailures(t *testing.T) {
	p := &probe{res: reach.Probe{TCP: true, DNS: false}}
	g, in, b := gate(p)
	g.BeginPass(refs("a.example", "10.0.0.2", "c.example", "d.example", "e.example", "f.example"))
	_ = g.Observe(context.Background(), "p0", unresolved(), at)
	_ = g.Observe(context.Background(), "p1", refused(), at)
	for _, id := range []string{"p2", "p3", "p4", "p5"} {
		_ = g.Observe(context.Background(), id, nil, at)
	}
	_ = g.EndPass(context.Background(), at)
	for _, o := range in.got {
		if o.id == "p0" {
			t.Fatal("a name failure was blamed on the panel while our resolver was down")
		}
	}
	if !contains(in.got, "p1") {
		t.Fatal("a refused dial was frozen although only our resolver was down")
	}
	if b.got[0].Egress != reach.EgressDNSDown {
		t.Fatalf("egress %q", b.got[0].Egress)
	}
}

// Two hundred providers do not fail in the same minute by coincidence: with
// the probes up, a mass failure is still ours (`suspect`).
func TestAMassFailureIsOursEvenWithTheProbesUp(t *testing.T) {
	p := &probe{res: reach.Probe{TCP: true, DNS: true}}
	g, in, b := gate(p)
	g.BeginPass(refs("a.example", "b.example", "c.example", "d.example", "e.example"))
	for _, id := range []string{"p0", "p1", "p2", "p3"} {
		_ = g.Observe(context.Background(), id, refused(), at)
	}
	_ = g.Observe(context.Background(), "p4", nil, at)
	_ = g.EndPass(context.Background(), at)
	if len(in.got) != 1 {
		t.Fatalf("panels were blamed in a mass failure: %+v", in.got)
	}
	if b.got[0].Egress != reach.EgressSuspect {
		t.Fatalf("egress %q", b.got[0].Egress)
	}
}

// Mass is counted by host. Six panels on one dead server are one server
// down, not our outage — and those panels are told so.
func TestManyPanelsOnOneDeadServerAreNotMass(t *testing.T) {
	p := &probe{res: reach.Probe{TCP: true, DNS: true}}
	g, in, b := gate(p)
	g.BeginPass(refs("dead.example", "dead.example", "dead.example", "dead.example", "dead.example", "dead.example",
		"b.example", "c.example", "d.example", "e.example"))
	for i := 0; i < 6; i++ {
		_ = g.Observe(context.Background(), fmt.Sprintf("p%d", i), refused(), at)
	}
	for i := 6; i < 10; i++ {
		_ = g.Observe(context.Background(), fmt.Sprintf("p%d", i), nil, at)
	}
	_ = g.EndPass(context.Background(), at)
	if len(in.got) != 10 {
		t.Fatalf("forwarded %d of 10: one server's outage was frozen as ours", len(in.got))
	}
	if b.got[0].Egress != reach.EgressOK || b.got[0].Asked != 10 || b.got[0].Failed != 6 {
		t.Fatalf("heartbeat %+v", b.got[0])
	}
}

// A pass with nothing to say still beats: silence is what a dead collector
// looks like, so a live one is never silent.
func TestEveryPassBeats(t *testing.T) {
	g, _, b := gate(&probe{res: reach.Probe{TCP: true, DNS: true}})
	g.BeginPass(nil)
	_ = g.EndPass(context.Background(), at)
	g.BeginPass(nil)
	_ = g.EndPass(context.Background(), at.Add(time.Minute))
	if len(b.got) != 2 || !b.got[1].PassAt.Equal(at.Add(time.Minute)) || b.got[1].Instance != "collector-1" {
		t.Fatalf("beats %+v", b.got)
	}
}

func contains(got []observed, id string) bool {
	for _, o := range got {
		if o.id == id {
			return true
		}
	}
	return false
}
