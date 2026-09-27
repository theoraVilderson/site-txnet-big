// Package leaseplan runs the lease planner (`internal/lease/quota`, ADR-0093)
// over this service's own rows: panels, configs, and the Grant's bag.
//
// It is the shadow (F-027-cy): each collection pass builds a `quota.Account`
// per Grant the pass touched, feeds the readings through `Observe`, runs
// `Plan`, and logs what it would write. It holds no driver and writes no row,
// so it cannot be a second writer of a ceiling (ADR-0093 rule 3). What it
// learns of a panel — the tick and the lag — is kept on the panel's row
// (F-027-cz, `Learned`); a replica's rates are relearned in memory.
package leaseplan

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/lease/quota"
)

// Grant is one Grant as the planner is built from it (`contract.lease.md`):
// Quota is billing's bag, read, and Used is what its configs' counters served.
type Grant struct {
	ID        string
	Quota     int64
	Used      int64
	ExpiresAt time.Time // zero = no end
	Configs   []Config
}

// Config is one of the Grant's configs, as the live writer left it.
type Config struct {
	ID      string
	PanelID string
	// Exists: the client is on the panel (`remoteId` is set).
	Exists bool
	// Counter is the panel's own figure at the last read, up plus down.
	Counter int64
	// LimitSeen is `appliedCeilingBytes`, the ceiling the panel enforces; 0
	// when none is applied.
	LimitSeen int64
	// Enabled is `desiredEnabled`. The bulk read carries no enable flag, so
	// what the live writer asked for is the best figure there is.
	Enabled bool
	// Allocated is the live split (`allocatedCeilingBytes`), logged beside
	// the planner's figure for F-027-da; nil when there is none.
	Allocated *int64
}

// Panel is what the planner needs of a panel row.
type Panel struct {
	ID         string
	DriverType driver.DriverType
	// CanSetLimit: the panel keeps a per-client byte ceiling it counts on the
	// same counter, so the replica runs in lease mode.
	CanSetLimit bool
	// Healthy is `panelState = healthy`.
	Healthy bool
	// Learned is what an earlier process saved of it.
	Learned Learned
}

// Learned is what the planner learned of one panel and keeps across a restart,
// on `network.panel` (F-027-cz, `contract.lease.md`). A panel's lag takes
// crossings to learn and its tick minutes of polls; a planner that lost them
// on a deploy would overshoot while it relearned.
type Learned struct {
	// TickPeriod is the J the clock's bins are cut from (`tickPeriodMs`);
	// zero = the family's (JobInterval).
	TickPeriod time.Duration
	// TickMask is the clock's feasible phase bins (`tickPhaseMask`); nil =
	// no poll observed yet.
	TickMask *uint32
	// The lag estimate (`quota.Lag`): EWMA mean and variance in seconds over
	// LagSamples crossings; both zero with no sample.
	LagMeanSec, LagVarianceSec2 float64
	LagSamples                  int
}

// Equal compares two by value, the mask included.
func (l Learned) Equal(o Learned) bool {
	if (l.TickMask == nil) != (o.TickMask == nil) || (l.TickMask != nil && *l.TickMask != *o.TickMask) {
		return false
	}
	return l.TickPeriod == o.TickPeriod && l.LagMeanSec == o.LagMeanSec &&
		l.LagVarianceSec2 == o.LagVarianceSec2 && l.LagSamples == o.LagSamples
}

func learnedOf(st *quota.PanelState) Learned {
	l := Learned{TickPeriod: st.Clock.J, LagMeanSec: st.Lag.Mean, LagVarianceSec2: st.Lag.Var, LagSamples: st.Lag.N}
	if mask, ok := st.Clock.Mask(); ok {
		l.TickMask = &mask
	}
	return l
}

// Snapshot is one read: the touched Grants, and every panel their configs are on.
type Snapshot struct {
	Grants []Grant
	Panels map[string]Panel
}

// Store loads the Grants that hold any of the given configs, each with all
// its configs, and keeps what the planner learned of a panel —
// `PostgresStore` in a running process.
type Store interface {
	Load(ctx context.Context, configIDs []string) (Snapshot, error)
	SaveLearned(ctx context.Context, panelID string, l Learned) error
}

// Plan is what the planner decided for one Grant on one pass.
type Plan struct {
	GrantID string
	Quota   int64
	Used    int64
	Avail   int64
	Endgame bool
	Closed  bool
	Actions []Action
}

// Action is one write the planner would make, and the live split beside it.
type Action struct {
	ConfigID  string
	PanelID   string
	Create    bool
	Limit     int64
	Enable    bool
	Priority  string
	Reason    string
	Allocated *int64
}

// Shadow is the planner run beside the live allocator. The zero value needs
// only a Store.
type Shadow struct {
	Store Store
	// Params are the planner's (quota.DefaultParams when zero).
	Params quota.Params
	Log    *slog.Logger

	mu       sync.Mutex
	panels   map[string]*quota.PanelState
	lastRead map[string]time.Time
	replicas map[string]*quota.Replica // by config id
	configOf map[int64]string          // replica id -> config id
	accounts map[string]*quota.Account // by Grant id
	saved    map[string]Learned        // by panel id: what the row holds
}

var _ collect.Shadow = (*Shadow)(nil)

// Observe is the loop's hook: plan, and log each plan and each action.
func (s *Shadow) Observe(ctx context.Context, p collect.Panel, readings []driver.ClientUsage, at time.Time) error {
	plans, err := s.Plan(ctx, p, readings, at)
	for _, pl := range plans {
		s.log().Info("lease shadow plan", "panel", p.ID, "grant", pl.GrantID, "quota", pl.Quota, "used", pl.Used,
			"avail", pl.Avail, "endgame", pl.Endgame, "closed", pl.Closed, "actions", len(pl.Actions))
		for _, a := range pl.Actions {
			attrs := []any{"grant", pl.GrantID, "config", a.ConfigID, "panel", a.PanelID, "limit", a.Limit,
				"enable", a.Enable, "create", a.Create, "priority", a.Priority, "reason", a.Reason}
			if a.Allocated != nil {
				attrs = append(attrs, "allocated", *a.Allocated)
			}
			s.log().Info("lease shadow action", attrs...)
		}
	}
	return err
}

// Plan runs one pass of SPEC §4 for the panel just read: the tick, the ledger,
// then a plan per touched Grant. It returns the plans ordered by Grant id,
// then saves what the pass taught it of the panel if that moved. A failed
// save still returns the plans, beside the error.
func (s *Shadow) Plan(ctx context.Context, p collect.Panel, readings []driver.ClientUsage, at time.Time) ([]Plan, error) {
	plans, learned, err := s.plan(ctx, p, readings, at)
	if err != nil || learned == nil {
		return plans, err
	}
	if err := s.Store.SaveLearned(ctx, p.ID, *learned); err != nil {
		return plans, fmt.Errorf("saving what panel %s taught the planner: %w", p.ID, err)
	}
	s.mu.Lock()
	s.saved[p.ID] = *learned
	s.mu.Unlock()
	return plans, nil
}

// Learned is what the shadow holds of a panel now; false before it has seen one.
func (s *Shadow) Learned(panelID string) (Learned, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.panels[panelID]
	if st == nil {
		return Learned{}, false
	}
	return learnedOf(st), true
}

// plan is Plan under the lock; learned is non-nil when the panel's state
// differs from what its row holds.
func (s *Shadow) plan(ctx context.Context, p collect.Panel, readings []driver.ClientUsage, at time.Time) ([]Plan, *Learned, error) {
	read := map[string]driver.ClientUsage{} // config id -> reading
	ids := make([]string, 0, len(readings))
	for _, r := range readings {
		if ref, ok := p.Configs[r.RemoteID]; ok {
			read[ref.ConfigID] = r
			ids = append(ids, ref.ConfigID)
		}
	}
	if len(ids) == 0 {
		return nil, nil, nil
	}
	sort.Strings(ids)
	snap, err := s.Store.Load(ctx, ids)
	if err != nil {
		return nil, nil, fmt.Errorf("loading the Grants of panel %s: %w", p.ID, err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	for _, pn := range snap.Panels {
		s.panel(pn)
	}
	here := s.panels[p.ID]
	if here != nil {
		here.Healthy = true // it has just answered
		if prev := s.lastRead[p.ID]; !prev.IsZero() {
			here.PollInterval = at.Sub(prev)
		}
	}

	// The learned replicas, their want side mirrored from the live writer:
	// the shadow's own wants are never written, so a want left on the
	// replica would read as a write in flight that never lands.
	byID := map[string]Config{}
	for _, g := range snap.Grants {
		for _, c := range g.Configs {
			byID[c.ID] = c
			r := s.replica(c)
			if r == nil {
				continue
			}
			r.LimitSeen, r.EnabledSeen = c.LimitSeen, c.Enabled
			r.LimitWant, r.LimitPeak, r.WantEnabled = c.LimitSeen, c.LimitSeen, c.Enabled
		}
	}

	// The tick: any counter moved, while any client was consuming.
	changed, active := false, false
	counters := map[string]int64{}
	for id, rd := range read {
		r := s.replicas[id]
		if r == nil {
			continue
		}
		counters[id] = counter(p.CounterSemantics, r, rd)
		changed = changed || counters[id] != r.Counter
		active = active || r.Rate.Now() > s.params().IdleRate
	}
	if here != nil {
		here.Clock.Observe(s.lastRead[p.ID], at, changed, active)
	}
	s.lastRead[p.ID] = at

	plans := make([]Plan, 0, len(snap.Grants))
	for _, g := range snap.Grants {
		a := s.account(g.ID)
		for _, c := range g.Configs {
			r := s.replicas[c.ID]
			if _, ok := read[c.ID]; !ok || r == nil || r.Panel.ID != p.ID {
				continue
			}
			a.Observe(r, quota.Observation{Counter: counters[c.ID], Limit: c.LimitSeen, Enabled: c.Enabled, At: at},
				s.params().DriftAfter)
		}
		// Observe charged this pass's deltas to Used; the counters already
		// hold them, so Used is the store's figure and nothing else.
		a.Quota, a.Used, a.ExpiresAt = g.Quota, g.Used, g.ExpiresAt
		a.Replicas = a.Replicas[:0]
		for _, c := range g.Configs {
			if r := s.replicas[c.ID]; r != nil {
				copied := *r // Plan writes its wants on the copy, never on what was learned
				a.Replicas = append(a.Replicas, &copied)
			}
		}
		res := a.Plan(at, s.params())
		pl := Plan{GrantID: g.ID, Quota: a.Quota, Used: a.Used, Avail: res.Avail, Endgame: res.Endgame, Closed: a.Closed}
		for _, act := range res.Actions {
			id := s.configOf[act.ReplicaID]
			pl.Actions = append(pl.Actions, Action{
				ConfigID: id, PanelID: act.PanelID, Create: act.Create, Limit: act.Limit, Enable: act.Enable,
				Priority: act.Priority.String(), Reason: act.Reason, Allocated: byID[id].Allocated,
			})
		}
		plans = append(plans, pl)
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].GrantID < plans[j].GrantID })
	if here != nil {
		if l := learnedOf(here); !l.Equal(s.saved[p.ID]) {
			return plans, &l, nil
		}
	}
	return plans, nil, nil
}

// counter is the figure a panel ceiling is measured against. A cumulative
// panel reports it; a reset-on-read panel reports what moved since the last
// read, so the running sum is the counter.
func counter(sem driver.CounterSemantics, r *quota.Replica, rd driver.ClientUsage) int64 {
	total := rd.UpBytes + rd.DownBytes
	if sem == driver.CounterResetOnRead {
		return r.Counter + total
	}
	return total
}

func (s *Shadow) init() {
	if s.panels != nil {
		return
	}
	s.panels = map[string]*quota.PanelState{}
	s.lastRead = map[string]time.Time{}
	s.replicas = map[string]*quota.Replica{}
	s.configOf = map[int64]string{}
	s.accounts = map[string]*quota.Account{}
	s.saved = map[string]Learned{}
}

// panel keeps one PanelState per panel, so what it learns outlives a pass. A
// panel first seen by this process starts from what its row holds.
func (s *Shadow) panel(pn Panel) {
	st := s.panels[pn.ID]
	if st == nil {
		j := pn.Learned.TickPeriod
		if j <= 0 {
			j = JobInterval(pn.DriverType)
		}
		clock := quota.NewTickClock(j)
		if pn.Learned.TickMask != nil {
			clock = quota.RestoreTickClock(j, *pn.Learned.TickMask)
		}
		lag := quota.NewLag(j)
		if pn.Learned.LagSamples > 0 {
			lag.Mean, lag.Var, lag.N = pn.Learned.LagMeanSec, pn.Learned.LagVarianceSec2, pn.Learned.LagSamples
		}
		st = &quota.PanelState{ID: pn.ID, JobInterval: j, Lag: lag, Clock: clock, Reliability: 1}
		s.panels[pn.ID] = st
		s.saved[pn.ID] = learnedOf(st)
	}
	st.CanSetLimit, st.Healthy = pn.CanSetLimit, pn.Healthy
}

// replica keeps one learned Replica per config. One first seen is adopted at
// the counter the store holds — the planner's own reading of a client it did
// not create — so its whole counter is never charged as one delta.
func (s *Shadow) replica(c Config) *quota.Replica {
	if r := s.replicas[c.ID]; r != nil {
		return r
	}
	st := s.panels[c.PanelID]
	if st == nil {
		return nil
	}
	id := int64(len(s.configOf) + 1)
	r := &quota.Replica{ID: id, Panel: st, Exists: c.Exists, Counter: c.Counter}
	s.replicas[c.ID], s.configOf[id] = r, c.ID
	return r
}

func (s *Shadow) account(grantID string) *quota.Account {
	a := s.accounts[grantID]
	if a == nil {
		a = &quota.Account{ID: grantID}
		s.accounts[grantID] = a
	}
	return a
}

func (s *Shadow) params() quota.Params {
	if s.Params.Horizon > 0 {
		return s.Params
	}
	return quota.DefaultParams()
}

func (s *Shadow) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// JobInterval is how often a family refreshes its counters and checks its
// ceilings — the planner's J for a panel whose row holds no `tickPeriodMs`. 3x-ui and its forks run their traffic job every 5 s
// (`driver/lag.go`); every other family is given 10 s, the figure the
// planner's simulator was tuned on.
func JobInterval(t driver.DriverType) time.Duration {
	switch t {
	case driver.DriverSanaee, driver.DriverThreeXUI, driver.DriverXUIAlireza, driver.DriverXUIVaxilu:
		return 5 * time.Second
	}
	return 10 * time.Second
}
