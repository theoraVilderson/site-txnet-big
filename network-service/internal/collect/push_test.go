package collect_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// sessionTotals is the receiver's side of a push panel, scripted: what each
// client's sessions have been accounted, as `radius_session` holds it. It
// keeps the router's own totals each turn handed it to rebase on.
type sessionTotals struct {
	bytes  map[string]int64
	router [][]driver.ClientUsage
}

func (s *sessionTotals) Totals(_ context.Context, _ string, router []driver.ClientUsage) ([]driver.ClientUsage, error) {
	s.router = append(s.router, router)
	out := make([]driver.ClientUsage, 0, len(s.bytes))
	for id, bytes := range s.bytes {
		out = append(out, driver.ClientUsage{RemoteID: id, DownBytes: bytes})
	}
	return out, nil
}

// readingPlanner keeps what each turn handed it.
type readingPlanner struct {
	mu       sync.Mutex
	readings [][]driver.ClientUsage
	failed   int
}

func (s *readingPlanner) Observe(_ context.Context, _ collect.Panel, rs []driver.ClientUsage, _ time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.readings = append(s.readings, rs)
	return false, nil
}
func (s *readingPlanner) Allocate(context.Context, collect.Panel, time.Time) error { return nil }
func (s *readingPlanner) Failed(string, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failed++
}

type pushRig struct {
	panel   *fake.Panel
	loop    *collect.Loop
	sink    *recorder
	planner *readingPlanner
	turns   *turnLog
}

func newPushRig(t *testing.T, totals map[string]int64) *pushRig {
	t.Helper()
	fp := fake.New(fake.Config{Transport: driver.TransportPush, CounterSemantics: driver.CounterSession})
	fp.Given("c1")
	p := collect.Panel{
		ID: "panel-push", CounterSemantics: driver.CounterSession, Transport: driver.TransportPush,
		Driver: fp, ReviewState: driver.ReviewAccepted,
		Configs: map[string]collect.ConfigRef{"c1": {ConfigID: "config-c1", Protocol: "l2tp"}},
	}
	r := &pushRig{panel: fp, sink: &recorder{}, planner: &readingPlanner{}, turns: &turnLog{}}
	r.loop = &collect.Loop{
		Source:   collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return []collect.Panel{p}, nil }),
		Sink:     r.sink,
		Cursors:  collect.NewMemoryCursors(),
		Ceilings: r.turns,
		Planner:  r.planner,
		Sessions: &sessionTotals{bytes: totals},
	}
	return r
}

// A push panel's bytes arrive as RADIUS packets and are billed by the
// receiver. Its turn plans on what the receiver accounted and converges, so a
// metered or capped Grant on it is enforced (F-027-du) — and it never reads
// the router's sessions, which would offer the same bytes a second time.
func TestAPushPanelsTurnPlansOnTheReceiversBytes(t *testing.T) {
	r := newPushRig(t, map[string]int64{"c1": 3 * gb})

	report, err := r.loop.Pass(context.Background())
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if report.Collected != 1 || len(report.Failed) != 0 {
		t.Fatalf("report = %+v, want the push panel's turn completed", report)
	}
	if n := r.panel.CallCount("GetUsage"); n != 0 {
		t.Fatalf("GetUsage called %d time(s): the receiver already billed these bytes", n)
	}
	if r.sink.calls != 0 {
		t.Fatalf("published %d time(s); a push turn bills nothing", r.sink.calls)
	}
	if len(r.planner.readings) != 1 {
		t.Fatalf("planner turns = %d, want 1", len(r.planner.readings))
	}
	got := r.planner.readings[0]
	if len(got) != 1 || got[0].RemoteID != "c1" || got[0].UpBytes+got[0].DownBytes != 3*gb {
		t.Fatalf("planner readings = %+v, want c1 at 3 GiB", got)
	}
	if n := r.turns.count("panel-push"); n != 1 {
		t.Fatalf("converged %d time(s), want 1: the ceiling has to reach User Manager", n)
	}
}

// The ceiling is enforced through the router's REST API, so a push panel's
// turn still asks it one thing: whether that API answers. A panel that does
// not is an outage the planner hears of, and nothing is planned on it.
// The router's own totals ride the same turn: they are what shows a user
// deleted and made again by hand, which our Σ cannot (F-027-du). Reading
// them proves the API answers, so no HealthCheck is spent beside them.
func TestAPushPanelsTurnHandsTheRoutersOwnTotalsOn(t *testing.T) {
	r := newPushRig(t, map[string]int64{"c1": 3 * gb})
	r.panel.Serve("c1", 0, 2*gb)

	if _, err := r.loop.Pass(context.Background()); err != nil {
		t.Fatalf("pass: %v", err)
	}
	router := r.loop.Sessions.(*sessionTotals).router
	if len(router) != 1 || len(router[0]) != 1 || router[0][0].RemoteID != "c1" || router[0][0].DownBytes != 2*gb {
		t.Fatalf("router totals handed on = %+v, want c1 at 2 GiB", router)
	}
	if n := r.panel.CallCount("HealthCheck"); n != 0 {
		t.Fatalf("HealthCheck called %d time(s) beside a read that already proves the API", n)
	}
}

func TestAPushPanelWhoseApiDoesNotAnswerIsNotPlanned(t *testing.T) {
	r := newPushRig(t, map[string]int64{"c1": gb})
	r.panel.FailNextCall(http.StatusBadGateway)

	report, err := r.loop.Pass(context.Background())
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(report.Failed) != 1 || report.Failed[0].Op != "ClientTotals" {
		t.Fatalf("failed = %+v, want the router's totals", report.Failed)
	}
	if r.planner.failed != 1 || len(r.planner.readings) != 0 {
		t.Fatalf("planner failed=%d turns=%d, want the outage and no plan", r.planner.failed, len(r.planner.readings))
	}
}
