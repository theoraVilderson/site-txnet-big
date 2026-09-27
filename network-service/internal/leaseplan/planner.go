// Package leaseplan runs the lease planner (`internal/lease/quota`, ADR-0093)
// over this service's own rows: panels, configs, and the Grant's bag.
//
// Since F-027-db it is the only writer of a config's ceiling
// (`allocatedCeilingBytes`, ADR-0093 rule 1): each collection turn builds a
// `quota.Account` per Grant the turn touched, feeds the readings through
// `Observe`, runs `Plan`, and writes each action's limit to the config's row,
// with the pessimistic `limitPeakBytes` and `writePending` beside it. It holds
// no driver: the convergence pass carries the figure to the panel. What it
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

// Config is one of the Grant's configs, as its row holds it.
//
// Two bases meet here (`contract.lease.md` rule 16). The planner counts on
// the panel's counter; the row counts in lifetime bytes, the basis the
// convergence pass translates from (`contract.ceiling.md`). Offset is the
// difference, so a planner figure plus Offset is the row's.
type Config struct {
	ID      string
	PanelID string
	// Exists: the client is on the panel (`remoteId` is set).
	Exists bool
	// Counter is the panel's own figure at the last read, up plus down.
	Counter int64
	// Offset is max(0, lifetime served − Counter): what the convergence
	// pass subtracts from a row figure, so what the planner adds back.
	Offset int64
	// LimitSeen is `appliedCeilingBytes` less Offset, the ceiling the panel
	// enforces on its own counter; 0 when none is applied.
	LimitSeen int64
	// Enabled is `desiredEnabled`. The bulk read carries no enable flag, so
	// what was asked for is the best figure there is.
	Enabled bool
	// Allocated is `allocatedCeilingBytes` and Peak `limitPeakBytes`, in the
	// row's basis; nil when the row holds none. Pending is `writePending`.
	Allocated, Peak *int64
	Pending         bool
}

// Lease is what one plan writes back to one config's row, in the row's
// basis. Allocated nil leaves `allocatedCeilingBytes` as it is.
type Lease struct {
	ConfigID  string
	Allocated *int64
	Peak      int64
	Pending   bool
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

// Store loads the Grants that hold any of the given configs, or a config on
// the panel that no plan has given a ceiling yet, each with all its configs;
// it writes the leases a plan decided and keeps what the planner learned of
// a panel — `PostgresStore` in a running process.
type Store interface {
	Load(ctx context.Context, panelID string, configIDs []string) (Snapshot, error)
	SaveLeases(ctx context.Context, leases []Lease) error
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
	// Replicas is every replica of the Grant after the plan, what the panel
	// enforces beside what the planner wants: what the report is read from.
	Replicas []ReplicaView
	// Leases is what the plan wrote back to the rows.
	Leases []Lease
}

// ReplicaView is one replica on one plan: the counter, what the panel
// enforces, what the row held before the plan, and what the planner wants.
type ReplicaView struct {
	Config  string `json:"config"`
	Panel   string `json:"panel"`
	Counter int64  `json:"counter"`
	// Seen is `appliedCeilingBytes` and SeenEnabled `desiredEnabled`; 0 = no
	// ceiling applied.
	Seen        int64 `json:"seen"`
	SeenEnabled bool  `json:"seen_enabled"`
	Want        int64 `json:"want"`
	WantEnabled bool  `json:"want_enabled"`
	// Allocated is `allocatedCeilingBytes` as the row held it before this
	// plan; nil = none.
	Allocated *int64 `json:"allocated,omitempty"`
}

// Action is one write the planner made, and the row's figure before it.
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

// Planner is the lease planner over this service's rows. The zero value
// needs only a Store.
type Planner struct {
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
	next     int64                     // the last replica id handed out
}

var _ collect.Planner = (*Planner)(nil)

// Observe is the usage turn's hook: plan, write, and log each plan and each
// action.
func (s *Planner) Observe(ctx context.Context, p collect.Panel, readings []driver.ClientUsage, at time.Time) error {
	plans, err := s.Plan(ctx, p, readings, at)
	s.logPlans(p, plans)
	return err
}

// Allocate is the woken turn's hook (`contract.lease.md` rule 18): a turn
// that reads no usage plans only the Grants with a config on this panel that
// has no ceiling yet, so a new config gets its first share before the same
// turn's convergence looks for it. No tick and no counter is observed.
func (s *Planner) Allocate(ctx context.Context, p collect.Panel, at time.Time) error {
	plans, _, err := s.plan(ctx, p, nil, at, false)
	s.logPlans(p, plans)
	return err
}

func (s *Planner) logPlans(p collect.Panel, plans []Plan) {
	for _, pl := range plans {
		s.log().Info("lease shadow plan", "panel", p.ID, "grant", pl.GrantID, "quota", pl.Quota, "used", pl.Used,
			"avail", pl.Avail, "endgame", pl.Endgame, "closed", pl.Closed, "actions", len(pl.Actions),
			"replicas", pl.Replicas)
		for _, a := range pl.Actions {
			attrs := []any{"grant", pl.GrantID, "config", a.ConfigID, "panel", a.PanelID, "limit", a.Limit,
				"enable", a.Enable, "create", a.Create, "priority", a.Priority, "reason", a.Reason}
			if a.Allocated != nil {
				attrs = append(attrs, "allocated", *a.Allocated)
			}
			s.log().Info("lease shadow action", attrs...)
		}
	}
}

// Plan runs one pass of SPEC §4 for the panel just read: the tick, the ledger,
// then a plan per touched Grant, whose leases it writes. It returns the plans
// ordered by Grant id, then saves what the pass taught it of the panel if
// that moved. A failed save still returns the plans, beside the error.
func (s *Planner) Plan(ctx context.Context, p collect.Panel, readings []driver.ClientUsage, at time.Time) ([]Plan, error) {
	plans, learned, err := s.plan(ctx, p, readings, at, true)
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

// Learned is what the planner holds of a panel now; false before it has seen one.
func (s *Planner) Learned(panelID string) (Learned, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.panels[panelID]
	if st == nil {
		return Learned{}, false
	}
	return learnedOf(st), true
}

// plan loads, plans under the lock, then writes the leases. read says the
// turn read usage: only then is the tick observed and are the readings
// charged. learned is non-nil when the panel's state differs from its row.
func (s *Planner) plan(ctx context.Context, p collect.Panel, readings []driver.ClientUsage, at time.Time, read bool) ([]Plan, *Learned, error) {
	got := map[string]driver.ClientUsage{} // config id -> reading
	ids := make([]string, 0, len(readings))
	for _, r := range readings {
		if ref, ok := p.Configs[r.RemoteID]; ok {
			got[ref.ConfigID] = r
			ids = append(ids, ref.ConfigID)
		}
	}
	sort.Strings(ids)
	snap, err := s.Store.Load(ctx, p.ID, ids)
	if err != nil {
		return nil, nil, fmt.Errorf("loading the Grants of panel %s: %w", p.ID, err)
	}
	plans, learned := s.planLocked(p, snap, got, at, read)

	var leases []Lease
	for _, pl := range plans {
		leases = append(leases, pl.Leases...)
	}
	if len(leases) > 0 {
		if err := s.Store.SaveLeases(ctx, leases); err != nil {
			// The rows still hold the last figures, and the replicas in
			// memory are ahead of them: forget them, so the next turn
			// restores from what was actually written.
			s.forget(leases)
			return plans, nil, fmt.Errorf("writing %d lease(s) for panel %s: %w", len(leases), p.ID, err)
		}
	}
	return plans, learned, nil
}

func (s *Planner) planLocked(p collect.Panel, snap Snapshot, got map[string]driver.ClientUsage, at time.Time, read bool) ([]Plan, *Learned) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	for _, pn := range snap.Panels {
		s.panel(pn)
	}
	here := s.panels[p.ID]
	if here != nil && read {
		here.Healthy = true // it has just answered
		if prev := s.lastRead[p.ID]; !prev.IsZero() {
			here.PollInterval = at.Sub(prev)
		}
	}

	// The seen side is the row's; the want side is the planner's own, kept
	// in memory and restored from the row by replica() after a restart.
	for _, g := range snap.Grants {
		for _, c := range g.Configs {
			if r := s.replica(c); r != nil {
				r.LimitSeen, r.EnabledSeen = c.LimitSeen, c.Enabled
			}
		}
	}

	// The tick: any counter moved, while any client was consuming.
	counters := map[string]int64{}
	if read {
		changed, active := false, false
		for id, rd := range got {
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
	}

	plans := make([]Plan, 0, len(snap.Grants))
	for _, g := range snap.Grants {
		a := s.account(g.ID)
		for _, c := range g.Configs {
			r := s.replicas[c.ID]
			if _, ok := counters[c.ID]; !ok || r == nil || r.Panel.ID != p.ID {
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
				a.Replicas = append(a.Replicas, r)
			}
		}
		res := a.Plan(at, s.params())
		pl := Plan{GrantID: g.ID, Quota: a.Quota, Used: a.Used, Avail: res.Avail, Endgame: res.Endgame, Closed: a.Closed}
		byID := map[string]Config{}
		for _, c := range g.Configs {
			byID[c.ID] = c
		}
		acted := map[string]Action{}
		for _, act := range res.Actions {
			id := s.configOf[act.ReplicaID]
			pa := Action{
				ConfigID: id, PanelID: act.PanelID, Create: act.Create, Limit: act.Limit, Enable: act.Enable,
				Priority: act.Priority.String(), Reason: act.Reason, Allocated: byID[id].Allocated,
			}
			pl.Actions = append(pl.Actions, pa)
			acted[id] = pa
		}
		for _, c := range g.Configs {
			r := s.replicas[c.ID]
			if r == nil {
				continue
			}
			v := ReplicaView{Config: c.ID, Panel: c.PanelID, Counter: c.Counter, Seen: c.LimitSeen,
				SeenEnabled: c.Enabled, Want: r.LimitWant, WantEnabled: r.WantEnabled, Allocated: c.Allocated}
			if n, ok := counters[c.ID]; ok {
				v.Counter = n
			}
			pl.Replicas = append(pl.Replicas, v)
			_, wrote := acted[c.ID]
			if l, moved := leaseOf(c, r, wrote); moved {
				pl.Leases = append(pl.Leases, l)
			}
		}
		plans = append(plans, pl)
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].GrantID < plans[j].GrantID })
	if here != nil && read {
		if l := learnedOf(here); !l.Equal(s.saved[p.ID]) {
			return plans, &l
		}
	}
	return plans, nil
}

// leaseOf is what the replica's row should hold after a plan, in the row's
// basis, and whether that differs from what it holds. The allocation moves
// only on an action — a replica the plan left alone keeps the figure it has,
// even a null one — while the peak and the pending flag follow every
// confirmation the ledger saw.
func leaseOf(c Config, r *quota.Replica, wrote bool) (Lease, bool) {
	l := Lease{ConfigID: c.ID, Peak: r.LimitPeak + c.Offset, Pending: r.Pending()}
	moved := c.Pending != l.Pending || c.Peak == nil || *c.Peak != l.Peak
	if wrote {
		want := r.LimitWant + c.Offset
		l.Allocated = &want
		moved = moved || c.Allocated == nil || *c.Allocated != want
	}
	if c.Allocated == nil && !wrote {
		// No ceiling yet, and none given: nothing on the row to be
		// pessimistic about.
		return l, false
	}
	return l, moved
}

// forget drops the replicas whose lease could not be written, so the next
// turn restores them from their rows.
func (s *Planner) forget(leases []Lease) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range leases {
		if r := s.replicas[l.ConfigID]; r != nil {
			delete(s.configOf, r.ID)
			delete(s.replicas, l.ConfigID)
		}
	}
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

func (s *Planner) init() {
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
func (s *Planner) panel(pn Panel) {
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
// not create — so its whole counter is never charged as one delta. Its want
// side is restored from the row (`contract.lease.md` rule 17): the last
// figure written, the peak not yet confirmed down, and a write in flight.
func (s *Planner) replica(c Config) *quota.Replica {
	if r := s.replicas[c.ID]; r != nil {
		return r
	}
	st := s.panels[c.PanelID]
	if st == nil {
		return nil
	}
	s.next++
	r := &quota.Replica{ID: s.next, Panel: st, Exists: c.Exists, Counter: c.Counter,
		LimitSeen: c.LimitSeen, EnabledSeen: c.Enabled, LimitWant: c.LimitSeen, WantEnabled: c.Enabled}
	if c.Allocated != nil {
		r.LimitWant = max(*c.Allocated-c.Offset, 0)
	}
	r.LimitPeak = max(r.LimitWant, r.LimitSeen)
	if c.Peak != nil {
		r.LimitPeak = max(*c.Peak-c.Offset, r.LimitSeen)
	}
	r.RestorePending(c.Pending)
	s.replicas[c.ID], s.configOf[s.next] = r, c.ID
	return r
}

func (s *Planner) account(grantID string) *quota.Account {
	a := s.accounts[grantID]
	if a == nil {
		a = &quota.Account{ID: grantID}
		s.accounts[grantID] = a
	}
	return a
}

func (s *Planner) params() quota.Params {
	if s.Params.Horizon > 0 {
		return s.Params
	}
	return quota.DefaultParams()
}

func (s *Planner) log() *slog.Logger {
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
