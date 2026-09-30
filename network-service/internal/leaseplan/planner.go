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
//
// On a metered Grant Quota is the bag plus the wallet's reserve — what the
// balance would still buy at the Grant's rate (F-027-dc) — and Purchased is
// the bag alone: the planner leases the whole of Quota, and asks billing for
// a block when Purchased runs out inside the horizon (BlockRequest).
type Grant struct {
	ID        string
	Quota     int64
	Used      int64
	Metered   bool
	Purchased int64
	// Unfunded is a metered Grant live on a platform panel whose reseller's
	// wallet funds no byte past the bag (WholesaleRoom 0, F-118-w): its block
	// is asked for every WholesaleRetry, not every BlockRetry.
	Unfunded  bool
	ExpiresAt time.Time // zero = no end
	Configs   []Config
	// Closure is the Grant's row on `network.lease_close`; nil = open.
	Closure *Closure
}

// Closure is a Grant the planner closed (F-027-dd, SPEC §6-2): the Quota and
// end it closed on. While it stands every config of the Grant is desired
// disabled — the panel drops the client at once rather than a tick after the
// counter meets its ceiling — and only a renewal past these figures, with at
// least ReopenMin available, deletes it (`contract.lease.md` rule 24).
type Closure struct {
	Quota     int64
	ExpiresAt time.Time // zero = no end
	// Reason is why it closed (F-027-dz): billing suspends a prepaid Grant
	// on spent or ended, never on guard.
	Reason quota.CloseReason
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
	// Enabled is `desiredEnabled` and no close on the Grant (F-027-dd). The
	// bulk read carries no enable flag, so what was asked for is the best
	// figure there is.
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
	// The outage history (`quota.Outages`, F-027-dh): the count as of
	// OutageAt (`outageWeight`, `outageWeightAt`); 0 and the zero time with
	// none. Its decay is computed, so only an outage moves it.
	OutageWeight float64
	OutageAt     time.Time
}

// Equal compares two by value, the mask included.
func (l Learned) Equal(o Learned) bool {
	if (l.TickMask == nil) != (o.TickMask == nil) || (l.TickMask != nil && *l.TickMask != *o.TickMask) {
		return false
	}
	return l.TickPeriod == o.TickPeriod && l.LagMeanSec == o.LagMeanSec &&
		l.LagVarianceSec2 == o.LagVarianceSec2 && l.LagSamples == o.LagSamples &&
		l.OutageWeight == o.OutageWeight && l.OutageAt.Equal(o.OutageAt)
}

func learnedOf(st *quota.PanelState) Learned {
	l := Learned{TickPeriod: st.Clock.J, LagMeanSec: st.Lag.Mean, LagVarianceSec2: st.Lag.Var, LagSamples: st.Lag.N,
		OutageWeight: st.Outages.Weight, OutageAt: st.Outages.At}
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
	// SaveClosure writes a Grant's close, or deletes it when c is nil.
	SaveClosure(ctx context.Context, grantID string, c *Closure) error
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
	// Block is the block this plan asks billing for; nil = none due, or
	// the same bag was asked for inside BlockRetry.
	Block *BlockRequest
	// Closure is the Grant's close after this plan, and ClosureMoved says
	// it differs from the row: a close or a reopen to write.
	Closure      *Closure
	ClosureMoved bool
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
	// Blocks carries a metered Grant's block requests to billing; nil asks
	// for nothing.
	Blocks BlockRequester
	// Metrics counts the planned writes and the false cut (F-027-dm); nil
	// counts nothing.
	Metrics *Metrics

	mu       sync.Mutex
	panels   map[string]*quota.PanelState
	lastRead map[string]time.Time
	replicas map[string]*quota.Replica // by config id
	configOf map[int64]string          // replica id -> config id
	accounts map[string]*quota.Account // by Grant id
	saved    map[string]Learned        // by panel id: what the row holds
	asked    map[string]asked          // by Grant id: the last block request sent
	next     int64                     // the last replica id handed out
	// pollBy is each panel's earliest `PollBy` hint since its last read
	// (SPEC §6-6), and probed its last read that landed mid-tick, or its
	// first read (F-027-de).
	pollBy map[string]time.Time
	probed map[string]time.Time
	// down is each panel's first failed read since it last answered: the
	// start of an outage the next answer measures (F-027-dh).
	down map[string]time.Time
	// cuts is each Grant's last plan, for Metrics' false-cut interval.
	cuts map[string]cutState
}

var _ collect.Planner = (*Planner)(nil)

// Observe is the usage turn's hook: plan, write, and log each plan and each
// action. It says whether the panel is owed a convergence (F-027-ds): see
// owes.
func (s *Planner) Observe(ctx context.Context, p collect.Panel, readings []driver.ClientUsage, at time.Time) (bool, error) {
	plans, err := s.Plan(ctx, p, readings, at)
	s.logPlans(p, plans)
	return s.owes(p.ID, plans), err
}

// owes: the plans left the panel something to carry — an action (a ceiling,
// an enable, a create), a Grant closed or reopened — or one of its replicas
// still waits on a write's read-back, which only the convergence step's
// `ListClients` gives (`contract.lease.md` rule 17). Anything else is a panel
// already holding what the rows say, and a poll that converged it would only
// read the whole panel to repeat it.
func (s *Planner) owes(panelID string, plans []Plan) bool {
	for _, pl := range plans {
		if len(pl.Actions) > 0 || pl.ClosureMoved {
			return true
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.replicas {
		if r.Panel != nil && r.Panel.ID == panelID && r.Pending() {
			return true
		}
	}
	return false
}

// Failed is told that a read of the panel failed at at. The first failure
// since the panel last answered starts an outage; the next read that answers
// ends it and adds it to the panel's history (`contract.lease.md` rule 27).
// Memory only: a restart mid-outage forgets its start, and that outage is
// not counted.
func (s *Planner) Failed(panelID string, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.init()
	if _, ok := s.down[panelID]; !ok {
		s.down[panelID] = at
	}
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
	for _, pl := range plans {
		if !pl.ClosureMoved {
			continue
		}
		if err := s.Store.SaveClosure(ctx, pl.GrantID, pl.Closure); err != nil {
			// The account in memory is ahead of its row: drop it, so the
			// next turn restores the close as it was written.
			s.forgetAccount(pl.GrantID)
			return plans, nil, fmt.Errorf("writing the close of Grant %s: %w", pl.GrantID, err)
		}
	}
	s.requestBlocks(ctx, plans)
	return plans, learned, nil
}

// blockLocked is the block a Grant's plan asks for, unless the same bag was
// asked for inside BlockRetry — WholesaleRetry for an Unfunded Grant. The rates are the replicas' own, summed: the
// fast one for when, the demand for how much, as the planner reads them.
func (s *Planner) blockLocked(g Grant, a *quota.Account, at time.Time) *BlockRequest {
	var now, demand float64
	for _, r := range a.Replicas {
		now += r.Rate.Now()
		demand += r.Rate.Demand()
	}
	req, due := blockDue(g, now, demand, s.params().Horizon, at)
	if !due {
		return nil
	}
	retry := BlockRetry
	if g.Unfunded {
		retry = WholesaleRetry
	}
	if prev, ok := s.asked[g.ID]; ok && prev.purchased == g.Purchased && at.Sub(prev.at) < retry {
		return nil
	}
	return &req
}

// requestBlocks sends each plan's block request. A request is remembered
// only once it has left, so one the broker refused is sent again on the
// next turn; a failure is logged and fails nothing (rule 8), because the
// reserve is still leased and billing's next answer is only late.
func (s *Planner) requestBlocks(ctx context.Context, plans []Plan) {
	if s.Blocks == nil {
		return
	}
	for _, pl := range plans {
		if pl.Block == nil {
			continue
		}
		b := *pl.Block
		if err := s.Blocks.RequestBlock(ctx, b); err != nil {
			s.log().Warn("lease block request not sent", "grant", b.GrantID, "purchased", b.PurchasedBytes, "err", err)
			continue
		}
		s.log().Info("lease block request", "grant", b.GrantID, "purchased", b.PurchasedBytes,
			"target", b.TargetBytes, "rate_bps", b.RateBps)
		s.mu.Lock()
		s.asked[b.GrantID] = asked{purchased: b.PurchasedBytes, at: b.RequestedAt}
		s.mu.Unlock()
	}
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
		if since, ok := s.down[p.ID]; ok {
			here.Outages.Add(at.Sub(since), at, s.params())
		}
	}
	if read {
		delete(s.down, p.ID)
	}
	for id := range snap.Panels {
		st := s.panels[id]
		st.Reliability = st.Outages.Reliability(at, s.params())
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
			s.markProbe(p.ID, &here.Clock, at)
		}
		s.lastRead[p.ID] = at
		// This read's plans hint the panel afresh; an older hint is stale.
		delete(s.pollBy, p.ID)
	}
	if here != nil {
		// The horizon stretch (quota.Params.horizon): the writes the panel
		// takes now, over the replicas consuming on it (F-027-df).
		here.WriteRate = collect.WriteRate(p)
		here.ActiveReplicas = 0
		for _, r := range s.replicas {
			if r.Panel != nil && r.Panel.ID == p.ID && r.Rate.Now() > s.params().IdleRate {
				here.ActiveReplicas++
			}
		}
	}

	plans := make([]Plan, 0, len(snap.Grants))
	for _, g := range snap.Grants {
		a := s.account(g)
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
		for id, t := range res.PollBy {
			if cur, ok := s.pollBy[id]; !ok || t.Before(cur) {
				s.pollBy[id] = t
			}
		}
		pl := Plan{GrantID: g.ID, Quota: a.Quota, Used: a.Used, Avail: res.Avail, Endgame: res.Endgame, Closed: a.Closed}
		// A closed metered Grant still asks for its spent bag (F-118-ad, rule
		// 21): what its reserve served past the bag is bought with it, and
		// billing's refusal is the only thing that suspends it.
		if !a.Closed || (g.Metered && g.Used >= g.Purchased) {
			pl.Block = s.blockLocked(g, a, at)
		}
		pl.Closure, pl.ClosureMoved = closureOf(g, a)
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
		s.record(pl, at)
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

// markProbe keeps when the panel was last read mid-tick: a read in the middle
// half of a tick is one the clock can still learn from. The first read counts
// as one, so the first probe is ProbeEvery after it.
func (s *Planner) markProbe(panelID string, c *quota.TickClock, at time.Time) {
	if _, ok := s.probed[panelID]; !ok {
		s.probed[panelID] = at
		return
	}
	if off, ok := c.SinceTick(at); ok && off >= c.J/4 && off <= 3*c.J/4 {
		s.probed[panelID] = at
	}
}

// NextPoll is when the panel should next be read (SPEC §6-6, F-027-de): the
// earliest `PollBy` hint of the plans since its last read, moved to
// PollGuard after the panel's tick (`TickClock.AlignPoll`) and no sooner
// than max(MinPoll, minPoll) after that read — minPoll is the panel's own
// budget (`collect.PollGap`). Every ProbeEvery one poll lands mid-tick
// instead, inside one tick of the last read, where only minPoll holds it.
// False when no plan hinted the panel: the bulk pass reads it.
func (s *Planner) NextPoll(panelID string, minPoll time.Duration) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	want, ok := s.pollBy[panelID]
	st := s.panels[panelID]
	if !ok || st == nil {
		return time.Time{}, false
	}
	last := s.lastRead[panelID]
	var lo time.Time
	if !last.IsZero() {
		lo = last.Add(max(s.params().MinPoll, minPoll))
	}
	if want.Before(lo) {
		want = lo
	}
	next := st.Clock.AlignPoll(want, last, PollGuard)
	for st.Clock.Known() && next.Before(lo) {
		next = next.Add(st.Clock.J)
	}
	if probed, ok := s.probed[panelID]; ok && st.Clock.Known() && last.Sub(probed) >= ProbeEvery {
		if mid := st.Clock.MidTick(last); mid.Sub(last) >= minPoll && mid.Before(next) {
			next = mid
		}
	}
	return next, true
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
	s.asked = map[string]asked{}
	s.pollBy = map[string]time.Time{}
	s.probed = map[string]time.Time{}
	s.down = map[string]time.Time{}
	s.cuts = map[string]cutState{}
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
		st = &quota.PanelState{ID: pn.ID, JobInterval: j, Lag: lag, Clock: clock, Reliability: 1,
			Outages: quota.Outages{Weight: pn.Learned.OutageWeight, At: pn.Learned.OutageAt}}
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

// account keeps one Account per Grant. One first seen by this process
// starts closed if its row on `network.lease_close` says so (F-027-dd).
func (s *Planner) account(g Grant) *quota.Account {
	a := s.accounts[g.ID]
	if a == nil {
		a = &quota.Account{ID: g.ID}
		if g.Closure != nil {
			a.RestoreClosed(g.Closure.Quota, g.Closure.ExpiresAt, g.Closure.Reason)
		}
		s.accounts[g.ID] = a
	}
	return a
}

func (s *Planner) forgetAccount(grantID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.accounts, grantID)
}

// closureOf is the Grant's close after a plan, and whether it differs from
// the row the snapshot read.
func closureOf(g Grant, a *quota.Account) (*Closure, bool) {
	q, end, why, closed := a.ClosedOn()
	if !closed {
		return nil, g.Closure != nil
	}
	c := &Closure{Quota: q, ExpiresAt: end, Reason: why}
	return c, g.Closure == nil || g.Closure.Quota != c.Quota || !g.Closure.ExpiresAt.Equal(c.ExpiresAt) || g.Closure.Reason != c.Reason
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

const (
	// PollGuard is how long after the panel's tick a poll lands: the tick's
	// write has landed by then, and the next tick is J away (SPEC §5).
	PollGuard = time.Second
	// ProbeEvery is how often a mid-tick poll re-checks the phase that the
	// aligned polls can no longer see move (SPEC §5).
	ProbeEvery = 5 * time.Minute
)

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
