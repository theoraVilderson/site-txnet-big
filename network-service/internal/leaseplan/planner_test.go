package leaseplan_test

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// store is the Grant read, scripted: what billing sold and what the counters
// say was served, per pass.
type store struct {
	mu     sync.Mutex
	grants []leaseplan.Grant
	panels map[string]leaseplan.Panel
	asked  [][]string
	leases []leaseplan.Lease
}

func (s *store) Load(_ context.Context, _ string, configIDs []string) (leaseplan.Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.asked = append(s.asked, append([]string(nil), configIDs...))
	grants := make([]leaseplan.Grant, len(s.grants))
	for i, g := range s.grants {
		grants[i] = g
		grants[i].Configs = append([]leaseplan.Config(nil), g.Configs...)
	}
	return leaseplan.Snapshot{Grants: grants, Panels: s.panels}, nil
}

// SaveLeases is the row write: each lease lands on its config, as
// `PostgresStore` writes `network.config`.
func (s *store) SaveLeases(_ context.Context, leases []leaseplan.Lease) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.leases = append(s.leases, leases...)
	for _, l := range leases {
		for gi := range s.grants {
			for ci := range s.grants[gi].Configs {
				c := &s.grants[gi].Configs[ci]
				if c.ID != l.ConfigID {
					continue
				}
				if l.Allocated != nil {
					v := *l.Allocated
					c.Allocated = &v
				}
				peak := l.Peak
				c.Peak, c.Pending = &peak, l.Pending
			}
		}
	}
	return nil
}

func (s *store) SaveLearned(context.Context, string, leaseplan.Learned) error { return nil }

func (s *store) set(used int64, configs ...leaseplan.Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.grants = []leaseplan.Grant{{ID: "grant-1", Quota: quota.GB, Used: used, Configs: configs}}
}

const panelID = "panel-1"

func newStore() *store {
	return &store{panels: map[string]leaseplan.Panel{
		panelID: {ID: panelID, DriverType: driver.DriverSanaee, CanSetLimit: true, Healthy: true},
	}}
}

func panel(configs ...string) collect.Panel {
	refs := map[string]collect.ConfigRef{}
	for _, c := range configs {
		refs[c] = collect.ConfigRef{ConfigID: "config-" + c, Protocol: "vless"}
	}
	return collect.Panel{ID: panelID, CounterSemantics: driver.CounterCumulative, Configs: refs}
}

func reading(remoteID string, total int64) driver.ClientUsage {
	return driver.ClientUsage{RemoteID: remoteID, DownBytes: total}
}

// Quota is billing's bag and Used is what the counters served: the plan is
// built from both as the store gives them, and no lease it asks for is more
// than the balance left.
func TestAPlanIsBuiltFromQuotaAndTheCounters(t *testing.T) {
	s := newStore()
	sh := &leaseplan.Planner{Store: s}
	t0 := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	p := panel("c1", "c2")

	s.set(100*quota.MB,
		leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true, Counter: 100 * quota.MB, LimitSeen: 500 * quota.MB, Enabled: true},
		leaseplan.Config{ID: "config-c2", PanelID: panelID, Exists: true, LimitSeen: 500 * quota.MB, Enabled: true})
	if _, err := sh.Plan(context.Background(), p, []driver.ClientUsage{reading("c1", 100*quota.MB), reading("c2", 0)}, t0); err != nil {
		t.Fatalf("pass 1: %v", err)
	}

	// A minute at 5 MB/s on c1.
	s.set(400*quota.MB,
		leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true, Counter: 400 * quota.MB, LimitSeen: 500 * quota.MB, Enabled: true},
		leaseplan.Config{ID: "config-c2", PanelID: panelID, Exists: true, LimitSeen: 500 * quota.MB, Enabled: true})
	plans, err := sh.Plan(context.Background(), p, []driver.ClientUsage{reading("c1", 400*quota.MB), reading("c2", 0)}, t0.Add(time.Minute))
	if err != nil {
		t.Fatalf("pass 2: %v", err)
	}
	if len(plans) != 1 {
		t.Fatalf("plans = %d, want the one touched Grant", len(plans))
	}
	plan := plans[0]
	if plan.GrantID != "grant-1" || plan.Quota != quota.GB || plan.Used != 400*quota.MB {
		t.Fatalf("plan = %+v, want grant-1 with Quota 1 GiB and Used 400 MiB exactly as read", plan)
	}
	if len(plan.Actions) == 0 {
		t.Fatalf("no action: the live 500/500 split is not what the planner would write for %+v", plan)
	}
	counters := map[string]int64{"config-c1": 400 * quota.MB, "config-c2": 0}
	var lease int64
	for _, a := range plan.Actions {
		if a.PanelID != panelID {
			t.Errorf("action %+v names panel %q", a, a.PanelID)
		}
		if a.Enable && a.Limit > counters[a.ConfigID] {
			lease += a.Limit - counters[a.ConfigID]
		}
	}
	if balance := plan.Quota - plan.Used; lease > balance {
		t.Errorf("leases %d exceed the balance %d: %+v", lease, balance, plan.Actions)
	}

	// The report's view: every replica, the live ceiling beside the planner's.
	if len(plan.Replicas) != 2 {
		t.Fatalf("replicas = %+v, want both configs", plan.Replicas)
	}
	for _, v := range plan.Replicas {
		if v.Counter != counters[v.Config] || v.Seen != 500*quota.MB {
			t.Errorf("view %+v: counter or seen is not what was read", v)
		}
		for _, a := range plan.Actions {
			if a.ConfigID == v.Config && (v.Want != a.Limit || v.WantEnabled != a.Enable) {
				t.Errorf("view %+v does not carry its action %+v", v, a)
			}
		}
	}
}

// Only the configs this pass read are asked about: an unattributed client is
// nobody's Grant.
func TestOnlyTheConfigsReadAreLoaded(t *testing.T) {
	s := newStore()
	s.set(0)
	sh := &leaseplan.Planner{Store: s}
	_, err := sh.Plan(context.Background(), panel("c1"),
		[]driver.ClientUsage{reading("c1", 1), reading("stranger", 1)}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(s.asked) != 1 || strings.Join(s.asked[0], ",") != "config-c1" {
		t.Fatalf("asked %v, want [[config-c1]]", s.asked)
	}
}

// The planner has no path to a panel: it writes rows, and the convergence
// step carries them. Run through the real loop with no convergence, the only
// call the panel sees is the read, and the actions are in the log.
func TestThePlannerNeverCallsAPanel(t *testing.T) {
	far := fake.New(fake.Config{})
	far.Given("c1")
	s := newStore()
	var buf bytes.Buffer
	sh := &leaseplan.Planner{Store: s, Log: slog.New(slog.NewTextHandler(&buf, nil))}
	p := panel("c1")
	p.Driver = far
	p.Transport = driver.TransportPull
	p.ReviewState = driver.ReviewAccepted
	p.MaxLineRateBps = 1 << 40

	now := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	loop := &collect.Loop{
		Source:  collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return []collect.Panel{p}, nil }),
		Sink:    sinkFunc(func(context.Context, collect.Result) error { return nil }),
		Cursors: collect.NewMemoryCursors(),
		Planner: sh,
		Clock:   func() time.Time { return now },
	}
	for i := 0; i < 3; i++ {
		far.Serve("c1", 0, 300*quota.MB)
		s.set(int64(i+1)*300*quota.MB, leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true,
			Counter: int64(i+1) * 300 * quota.MB, LimitSeen: int64(i+1) * 300 * quota.MB, Enabled: true})
		if _, err := loop.Pass(context.Background()); err != nil {
			t.Fatal(err)
		}
		now = now.Add(time.Minute)
	}

	if reads := far.CallCount("GetUsage"); far.TotalCalls() != reads {
		t.Errorf("panel saw %d calls, %d of them reads: the planner reached the panel", far.TotalCalls(), reads)
	}
	if !strings.Contains(buf.String(), "lease shadow action") {
		t.Errorf("no action was logged:\n%s", buf.String())
	}
}

type sinkFunc func(context.Context, collect.Result) error

func (f sinkFunc) Publish(ctx context.Context, res collect.Result) error { return f(ctx, res) }
