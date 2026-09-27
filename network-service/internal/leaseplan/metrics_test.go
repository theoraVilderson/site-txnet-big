package leaseplan_test

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

func metricLine(t *testing.T, m *leaseplan.Metrics, prefix string) string {
	t.Helper()
	var b strings.Builder
	if _, err := m.WriteTo(&b); err != nil {
		t.Fatalf("WriteTo: %v", err)
	}
	for _, l := range strings.Split(b.String(), "\n") {
		if strings.HasPrefix(l, prefix+" ") {
			return strings.TrimPrefix(l, prefix+" ")
		}
	}
	return ""
}

// A config held at its live ceiling while its Grant still has bytes left is a
// false cut, counted from one plan of the Grant to the next on the panel the
// config is on. Past the bag it is the point, and across a gap longer than
// MaxTurnGap nothing is known (SPEC §10).
func TestFalseCutSecondsAreCountedBetweenTwoPlansOfAnOpenGrant(t *testing.T) {
	s := newStore()
	m := &leaseplan.Metrics{}
	pl := &leaseplan.Planner{Store: s, Metrics: m}
	t0 := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	p := panel("c1", "c2")
	cut := func(used int64) {
		s.set(used,
			leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true, Counter: used - 50*quota.MB, LimitSeen: 900 * quota.MB, Enabled: true},
			leaseplan.Config{ID: "config-c2", PanelID: panelID, Exists: true, Counter: 50 * quota.MB, LimitSeen: 50 * quota.MB, Enabled: true})
	}
	turn := func(at time.Time, used int64) {
		t.Helper()
		cut(used)
		if _, err := pl.Plan(context.Background(), p, []driver.ClientUsage{reading("c1", used-50*quota.MB), reading("c2", 50*quota.MB)}, at); err != nil {
			t.Fatalf("plan at %s: %v", at, err)
		}
	}
	const series = `network_planner_false_cut_seconds_total{panel="panel-1"}`

	turn(t0, 100*quota.MB)
	if got := metricLine(t, m, series); got != "" {
		t.Fatalf("first plan counted %s: no interval has passed yet", got)
	}
	turn(t0.Add(30*time.Second), 200*quota.MB)
	if got := metricLine(t, m, series); got != "30" {
		t.Fatalf("false cut = %q, want 30: c2 sat at its ceiling for 30s with 824 MiB left", got)
	}
	turn(t0.Add(30*time.Second+leaseplan.MaxTurnGap+time.Second), 300*quota.MB)
	if got := metricLine(t, m, series); got != "30" {
		t.Fatalf("false cut = %q after a gap past MaxTurnGap, want still 30", got)
	}
	turn(t0.Add(time.Hour), 900*quota.MB)
	turn(t0.Add(time.Hour+20*time.Second), quota.GB) // the bag is spent: a cut now is the point
	turn(t0.Add(time.Hour+40*time.Second), quota.GB)
	if got := metricLine(t, m, series); got != "50" {
		t.Fatalf("false cut = %q, want 50: the 20s before the bag ran out count, the 20s after do not", got)
	}
}

// Every action a plan emits is one write, counted by panel and Action.Reason,
// and the exposition is Prometheus text with HELP and TYPE for both series.
func TestEveryPlannedWriteIsCountedByItsReason(t *testing.T) {
	s := newStore()
	m := &leaseplan.Metrics{}
	pl := &leaseplan.Planner{Store: s, Metrics: m}
	t0 := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	p := panel("c1", "c2")
	byReason := map[string]int{}
	// A minute at 5 MB/s on c1, against the live 500/500 split.
	for i, used := range []int64{100 * quota.MB, 400 * quota.MB} {
		s.set(used,
			leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true, Counter: used, LimitSeen: 500 * quota.MB, Enabled: true},
			leaseplan.Config{ID: "config-c2", PanelID: panelID, Exists: true, LimitSeen: 500 * quota.MB, Enabled: true})
		plans, err := pl.Plan(context.Background(), p, []driver.ClientUsage{reading("c1", used), reading("c2", 0)}, t0.Add(time.Duration(i)*time.Minute))
		if err != nil {
			t.Fatalf("pass %d: %v", i, err)
		}
		for _, g := range plans {
			for _, a := range g.Actions {
				byReason[a.Reason]++
			}
		}
	}
	if len(byReason) == 0 {
		t.Fatal("no action planned: the live 500/500 split is not the planner's")
	}
	for reason, n := range byReason {
		series := `network_planner_writes_total{panel="panel-1",reason="` + reason + `"}`
		if got, want := metricLine(t, m, series), strconv.Itoa(n); got != want {
			t.Errorf("%s = %q, want %s", series, got, want)
		}
	}

	var b strings.Builder
	if _, err := m.WriteTo(&b); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"# TYPE network_planner_writes_total counter",
		"# TYPE network_planner_false_cut_seconds_total counter",
		"# HELP network_planner_writes_total ",
	} {
		if !strings.Contains(b.String(), want) {
			t.Errorf("exposition lacks %q:\n%s", want, b.String())
		}
	}
}

// A nil Metrics records nothing and a planner without one plans as before.
func TestAPlannerWithoutMetricsStillPlans(t *testing.T) {
	s := newStore()
	pl := &leaseplan.Planner{Store: s}
	s.set(0, leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true, LimitSeen: 500 * quota.MB, Enabled: true})
	if _, err := pl.Plan(context.Background(), panel("c1"), []driver.ClientUsage{reading("c1", 0)}, time.Now()); err != nil {
		t.Fatal(err)
	}
	var m *leaseplan.Metrics
	var b strings.Builder
	if _, err := m.WriteTo(&b); err != nil || b.Len() != 0 {
		t.Fatalf("nil Metrics wrote %q, %v", b.String(), err)
	}
}
