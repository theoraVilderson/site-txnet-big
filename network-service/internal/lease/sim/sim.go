// Package sim is a discrete-time simulator of panels + users + the engine.
// Panels are modelled pessimistically: counters and limit enforcement only
// move at the panel's job tick, enforcement has extra random delay, writes
// take time, the API can go down while the data plane keeps serving, and
// counters can be reset under our feet.
package sim

import (
	"fmt"
	"math"
	"math/rand"
	"time"

	"network-service/internal/lease/quota"
	"network-service/internal/lease/writeq"
)

type PanelCfg struct {
	ID           string
	Job          time.Duration // counter refresh + enforcement tick
	ExtraLagMax  time.Duration // extra uniform(0,max) delay before a cut
	WriteLatency time.Duration
	WriteRate    float64 // writes/s the panel tolerates
	CanSetLimit  bool
	LagGuess     time.Duration // initial lag estimate (0 = engine default)
	Outages      [][2]float64  // API down windows (seconds)
	DeadInOutage bool          // enforcement also dead (e.g. Marzban node keeps serving)
	Resets       []float64     // times when every counter on the panel is reset
}

type Renewal struct {
	At  float64
	Add quota.Bytes
}

type AcctCfg struct {
	Quota    quota.Bytes
	Panels   []int // one replica per entry (panel index)
	Renewals []Renewal
}

// Device consumes Rate bytes/s on replica Rep of account Acct during [From,To).
type Device struct {
	Acct, Rep int
	Rate      float64
	From, To  float64
}

type Scenario struct {
	Name      string
	Duration  float64
	Panels    []PanelCfg
	Accounts  []AcctCfg
	Devices   []Device
	Params    quota.Params
	Seed      int64
	Trace     func(format string, args ...any)
	TraceAcct int // -1 = all
}

type AcctResult struct {
	Purchased   quota.Bytes
	Consumed    float64
	OverPct     float64
	FalseCutSec float64 // device-seconds blocked while the account was open and > margin remained
	Closed      bool
	Balance     quota.Bytes // engine's view at end (credit + / debt -)
	PeriodUse   []float64   // true bytes consumed in each paid period (renewals split periods)
	PeriodPaid  []quota.Bytes
}

type Result struct {
	Name          string
	Accounts      []AcctResult
	Writes        int
	Polls         int
	PeakWritesMin int // worst writes in any 60 s window on one panel
	Lags          map[string]time.Duration
	ActiveHours   float64 // device-hours of consumption
	InvariantMax  float64 // worst (Used+ΣHold−Quota)/Quota seen, should be ≤ ~0
	Reasons       map[string]int
}

type client struct {
	trueC     float64
	reported  quota.Bytes
	limit     quota.Bytes
	enabled   bool
	disableAt float64
}

type pending struct {
	at   float64
	id   int64
	act  quota.Action
	fail bool
}

type panelSim struct {
	cfg      PanelCfg
	st       *quota.PanelState
	clients  map[int64]*client
	nextJob  float64
	q        *writeq.Queue
	tokens   float64
	inflight []pending
	nextPoll float64
	lastPoll float64
	reps     []*repRef
	writeLog []float64
	resetIdx int
	bgTrue   float64 // background traffic of other users on the panel
	bgRep    quota.Bytes
	bgSeen   quota.Bytes
}

type repRef struct {
	acct *acctSim
	r    *quota.Replica
}

type acctSim struct {
	cfg      AcctCfg
	a        *quota.Account
	trueUsed float64
	falseCut float64
	renewIdx int
	dirty    bool
	marks    []float64
}

func (p *panelSim) down(t float64) bool {
	for _, w := range p.cfg.Outages {
		if t >= w[0] && t < w[1] {
			return true
		}
	}
	return false
}

// Run executes a scenario with 1 s steps.
func Run(sc Scenario) Result {
	rng := rand.New(rand.NewSource(sc.Seed + 1))
	par := sc.Params
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	at := func(t float64) time.Time { return t0.Add(time.Duration(t * float64(time.Second))) }

	panels := make([]*panelSim, len(sc.Panels))
	byID := map[string]*panelSim{}
	for i, c := range sc.Panels {
		lag := quota.NewLag(c.Job)
		if c.LagGuess > 0 {
			lag.Init = c.LagGuess
		}
		p := &panelSim{
			cfg:     c,
			st:      &quota.PanelState{ID: c.ID, Healthy: true, CanSetLimit: c.CanSetLimit, JobInterval: c.Job, Lag: lag, Clock: quota.NewTickClock(c.Job), WriteRate: c.WriteRate, Reliability: 1},
			clients: map[int64]*client{},
			nextJob: rng.Float64() * c.Job.Seconds(),
			q:       writeq.New(),
			tokens:  2,
		}
		panels[i], byID[c.ID] = p, p
	}
	var nextID int64
	accts := make([]*acctSim, len(sc.Accounts))
	for i, c := range sc.Accounts {
		a := &quota.Account{ID: fmt.Sprint(i), Quota: c.Quota}
		as := &acctSim{cfg: c, a: a, dirty: true}
		for _, pi := range c.Panels {
			nextID++
			r := &quota.Replica{ID: nextID, Panel: panels[pi].st}
			a.Replicas = append(a.Replicas, r)
			panels[pi].reps = append(panels[pi].reps, &repRef{as, r})
		}
		accts[i] = as
	}

	res := Result{Name: sc.Name, Lags: map[string]time.Duration{}, Reasons: map[string]int{}}
	const dt = 1.0
	for t := 0.0; t < sc.Duration; t += dt {
		now := at(t)

		// renewals
		for _, as := range accts {
			for as.renewIdx < len(as.cfg.Renewals) && as.cfg.Renewals[as.renewIdx].At <= t {
				as.marks = append(as.marks, as.trueUsed)
				as.a.Renew(as.cfg.Renewals[as.renewIdx].Add, time.Time{})
				as.renewIdx++
				as.dirty = true
			}
		}
		// counter resets
		for _, p := range panels {
			for p.resetIdx < len(p.cfg.Resets) && p.cfg.Resets[p.resetIdx] <= t {
				for _, c := range p.clients {
					c.trueC, c.reported = 0, 0
				}
				p.resetIdx++
			}
		}
		// data plane
		for _, d := range sc.Devices {
			if t < d.From || t >= d.To {
				continue
			}
			as := accts[d.Acct]
			r := as.a.Replicas[d.Rep]
			p := byID[r.Panel.ID]
			c := p.clients[r.ID]
			if c != nil && c.enabled {
				c.trueC += d.Rate * dt
				as.trueUsed += d.Rate * dt
				res.ActiveHours += dt / 3600
			} else {
				paid := float64(as.a.Quota)
				margin := math.Max(0.02*paid, float64(20*quota.MB))
				if paid-as.trueUsed > margin && !as.a.Closed {
					as.falseCut += dt
				}
			}
		}
		// panel internals
		for _, p := range panels {
			dead := p.down(t) && p.cfg.DeadInOutage
			if !dead {
				p.bgTrue += 1e6 * dt // other users: panels are never empty in production
			}
			if t >= p.nextJob {
				p.nextJob += p.cfg.Job.Seconds()
				if !dead {
					p.bgRep = quota.Bytes(p.bgTrue)
					for _, c := range p.clients {
						c.reported = quota.Bytes(c.trueC)
						if c.enabled && c.reported >= c.limit && c.disableAt < 0 {
							c.disableAt = t + rng.Float64()*p.cfg.ExtraLagMax.Seconds()
						}
					}
				}
			}
			for _, c := range p.clients {
				if c.disableAt >= 0 && t >= c.disableAt && !dead {
					if c.reported >= c.limit {
						c.enabled = false
					}
					c.disableAt = -1
				}
			}
			// writes landing
			keep := p.inflight[:0]
			for _, w := range p.inflight {
				if w.at > t {
					keep = append(keep, w)
					continue
				}
				p.q.Done(w.id)
				ref := p.ref(w.id)
				if p.down(t) {
					p.q.Put(w.id, int(w.act.Priority), w.act, now) // failed: retry later
					continue
				}
				c := p.clients[w.id]
				if c == nil {
					c = &client{disableAt: -1}
					p.clients[w.id] = c
				}
				c.limit = w.act.Limit
				if w.act.Enable {
					if c.reported < c.limit {
						c.enabled, c.disableAt = true, -1
					}
				} else {
					c.enabled = false
				}
				ref.acct.a.ConfirmWrite(ref.r, c.limit, c.enabled)
				ref.acct.dirty = true
			}
			p.inflight = keep
			// writer
			if !p.down(t) {
				p.tokens = math.Min(3, p.tokens+p.cfg.WriteRate*dt)
				for p.tokens >= 1 {
					id, pl, ok := p.q.Pop(now)
					if !ok {
						break
					}
					p.tokens--
					res.Writes++
					res.Reasons[pl.(quota.Action).Reason]++
					p.writeLog = append(p.writeLog, t)
					p.inflight = append(p.inflight, pending{at: t + p.cfg.WriteLatency.Seconds(), id: id, act: pl.(quota.Action)})
				}
			}
			// poll
			if t >= p.nextPoll {
				if p.down(t) {
					if p.st.Healthy {
						p.st.Healthy = false
						for _, rr := range p.reps {
							rr.acct.dirty = true
						}
					}
					p.nextPoll = t + 15
				} else {
					res.Polls++
					p.st.Healthy = true
					p.st.PollInterval = time.Duration((t - p.lastPoll) * float64(time.Second))
					changed, activeAny := p.bgRep != p.bgSeen, true
					p.bgSeen = p.bgRep
					for _, rr := range p.reps {
						if c := p.clients[rr.r.ID]; c != nil && rr.r.Exists && c.reported != rr.r.Counter {
							changed = true
						}
						if rr.r.EnabledSeen && rr.r.Rate.Now() > par.IdleRate {
							activeAny = true
						}
					}
					if p.lastPoll > 0 || res.Polls > 1 {
						p.st.Clock.Observe(at(p.lastPoll), now, changed, activeAny)
					}
					p.lastPoll = t
					active := 0
					for _, rr := range p.reps {
						c := p.clients[rr.r.ID]
						if c == nil {
							if rr.r.Exists {
								rr.acct.a.Observe(rr.r, quota.Observation{Missing: true, At: now}, par.DriftAfter)
								rr.acct.dirty = true
							}
							continue
						}
						rr.acct.a.Observe(rr.r, quota.Observation{Counter: c.reported, Limit: c.limit, Enabled: c.enabled, At: now}, par.DriftAfter)
						rr.acct.dirty = true
						if rr.r.Rate.Now() > par.IdleRate {
							active++
						}
					}
					p.st.ActiveReplicas = active
					p.nextPoll = t + par.MaxPoll.Seconds()
				}
			}
		}
		// plan
		for ai, as := range accts {
			if !as.dirty {
				continue
			}
			as.dirty = false
			pr := as.a.Plan(now, par)
			if sc.Trace != nil && (sc.TraceAcct < 0 || sc.TraceAcct == ai) {
				sc.Trace("t=%4.0f acct %s used=%dMB true=%.0fMB avail=%dMB endgame=%v closed=%v lag=%v clock=%v", t, as.a.ID, as.a.Used/quota.MB, as.trueUsed/float64(quota.MB), pr.Avail/quota.MB, pr.Endgame, pr.Closed, as.a.Replicas[0].Panel.Lag.Reserve(par.LagZ), as.a.Replicas[0].Panel.Clock.Known())
				for _, r := range as.a.Replicas {
					c := byID[r.Panel.ID].clients[r.ID]
					tc, en, lim := 0.0, false, quota.Bytes(0)
					if c != nil {
						tc, en, lim = c.trueC, c.enabled, c.limit
					}
					sc.Trace("      rep%d cnt=%dMB lim=%dMB want=%dMB peak=%dMB en=%v/%v hold=%dMB rate=%.1f/%.1f | panel true=%.0fMB lim=%dMB en=%v", r.ID, r.Counter/quota.MB, r.LimitSeen/quota.MB, r.LimitWant/quota.MB, r.LimitPeak/quota.MB, r.EnabledSeen, r.WantEnabled, r.Hold()/quota.MB, r.Rate.Now()/mbps, r.Rate.Demand()/mbps, tc/float64(quota.MB), lim/quota.MB, en)
				}
				for _, act := range pr.Actions {
					sc.Trace("      -> rep%d limit=%dMB enable=%v %s(%s)", act.ReplicaID, act.Limit/quota.MB, act.Enable, act.Priority, act.Reason)
				}
			}
			for _, act := range pr.Actions {
				byID[act.PanelID].q.Put(act.ReplicaID, int(act.Priority), act, now)
			}
			for pid, by := range pr.PollBy {
				p := byID[pid]
				by = p.st.Clock.AlignPoll(by, at(p.lastPoll), time.Second)
				want := math.Max(by.Sub(t0).Seconds(), p.lastPoll+par.MinPoll.Seconds())
				if want < p.nextPoll {
					p.nextPoll = want
				}
			}
			// invariant probe
			var hold quota.Bytes
			for _, r := range as.a.Replicas {
				hold += r.Hold()
			}
			if as.a.Quota > 0 && !as.a.Closed {
				v := float64(as.a.Used+hold-as.a.Quota) / float64(as.a.Quota)
				if v > res.InvariantMax {
					res.InvariantMax = v
				}
			}
		}
	}

	for _, as := range accts {
		paid := as.a.Quota
		ar := AcctResult{
			Purchased: paid, Consumed: as.trueUsed, FalseCutSec: as.falseCut,
			Closed: as.a.Closed, Balance: as.a.Quota - as.a.Used,
		}
		ar.OverPct = (as.trueUsed - float64(paid)) / float64(paid) * 100
		prev := 0.0
		paidPrev := as.cfg.Quota
		for i, m := range append(as.marks, as.trueUsed) {
			ar.PeriodUse = append(ar.PeriodUse, m-prev)
			ar.PeriodPaid = append(ar.PeriodPaid, paidPrev)
			prev = m
			if i < len(as.cfg.Renewals) {
				paidPrev = as.cfg.Renewals[i].Add
			}
		}
		res.Accounts = append(res.Accounts, ar)
	}
	for _, p := range panels {
		res.Lags[p.cfg.ID] = p.st.Lag.Reserve(par.LagZ)
		j := 0
		for i := range p.writeLog {
			for p.writeLog[i]-p.writeLog[j] >= 60 {
				j++
			}
			if i-j+1 > res.PeakWritesMin {
				res.PeakWritesMin = i - j + 1
			}
		}
	}
	return res
}

func (p *panelSim) ref(id int64) *repRef {
	for _, r := range p.reps {
		if r.r.ID == id {
			return r
		}
	}
	return nil
}
