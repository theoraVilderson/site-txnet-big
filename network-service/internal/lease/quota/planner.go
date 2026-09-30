package quota

import (
	"math"
	"sort"
	"time"
)

// Priority orders writes inside a panel's write queue (lower = sooner).
type Priority int

const (
	PClose     Priority = iota // quota/expiry reached: cut now
	PRegrant                   // replica is blocked or about to be, budget exists
	PTopUp                     // replica running low
	PRebalance                 // move budget between replicas
	PMaintain                  // drift repair, creation of idle replicas
)

func (p Priority) String() string {
	return [...]string{"close", "regrant", "topup", "rebalance", "maintain"}[p]
}

// Action is one desired panel state for one replica. The write queue keys
// actions by ReplicaID and keeps only the latest (coalescing).
type Action struct {
	ReplicaID int64
	PanelID   string
	Create    bool
	Limit     Bytes // absolute panel limit (counter + lease)
	Enable    bool
	Priority  Priority
	Reason    string
}

// PlanResult is everything one planning pass decided.
type PlanResult struct {
	Actions []Action
	PollBy  map[string]time.Time // panel id -> want a fresh poll by then
	Avail   Bytes
	Endgame bool
	Closed  bool
}

func (r *PlanResult) hint(panel string, t time.Time) {
	if cur, ok := r.PollBy[panel]; !ok || t.Before(cur) {
		r.PollBy[panel] = t
	}
}

type view struct {
	r          *Replica
	vNow, vDem float64
	hold       Bytes
	lag, H     time.Duration
	pollAge    time.Duration

	healthy, writable, enabled, active, blocked bool

	target, floor, want, need Bytes
	hasWant                   bool
	prio                      Priority
	reason                    string
}

func (v *view) setWant(lease Bytes, p Priority, why string) {
	v.want, v.prio, v.reason, v.hasWant = max(lease, 0), p, why, true
}

// Plan is the whole algorithm for one account. Call it after every poll that
// touched the account, after write confirmations, and on quota/expiry change.
//
// Safety invariant it maintains (pessimistic, crash-safe):
//
//	Used + Σ Hold(r) + Σ rate(r)·Lag(r)  ≤  Quota
//
// where Hold uses the max of seen and requested limits, so budget is only
// re-granted once a shrink has been confirmed by the panel.
func (a *Account) Plan(now time.Time, p Params) PlanResult {
	res := PlanResult{PollBy: map[string]time.Time{}}
	vs := make([]*view, 0, len(a.Replicas))
	var lagRes, totNow float64
	var holdAll Bytes

	// Peaks from RAW estimates only (never from boosted ones, or the boost
	// would feed on itself).
	var rawTot, rawMax float64
	for _, r := range a.Replicas {
		rawTot += r.Rate.Now()
		rawMax = math.Max(rawMax, r.Rate.Now())
	}
	a.updatePeak(now, rawTot, rawMax)

	for _, r := range a.Replicas {
		pn := r.Panel
		v := &view{
			r: r, vNow: r.Rate.Now(), vDem: r.Rate.Demand(), hold: r.Hold(),
			lag: pn.Lag.Reserve(p.LagZ), H: p.horizon(pn),
			healthy: pn.Healthy, writable: pn.CanSetLimit,
			enabled: r.EnabledSeen || r.WantEnabled,
		}
		if !r.effAt.IsZero() {
			v.pollAge = max(now.Sub(r.effAt), 0) // age of the data, not of the poll
		}
		if r.Rate.Warming() {
			// just woke up: the first sample under-reads; assume the
			// account's recent peak until the estimate settles
			boost := math.Max(a.PeakReplica, p.PriorRate)
			v.vNow, v.vDem = math.Max(v.vNow, boost), math.Max(v.vDem, boost)
		}
		v.active = v.vNow > p.IdleRate
		v.blocked = !r.Exists || !r.EnabledSeen || (v.writable && r.Counter >= r.LimitSeen)
		if v.enabled {
			w, rate := v.lag, v.vNow
			if !v.writable {
				w += pn.PollInterval
				rate = v.vDem
			}
			if !v.healthy {
				rate = v.vDem
			}
			lagRes += rate * w.Seconds()
		}
		holdAll += v.hold
		if v.enabled && v.active {
			totNow += v.vNow
		}
		vs = append(vs, v)
	}

	avail := a.Quota - a.Used - toBytes(lagRes)
	res.Avail = avail
	expired := !a.ExpiresAt.IsZero() && !now.Before(a.ExpiresAt)

	// ---- open / close ------------------------------------------------------
	if a.Closed && !expired {
		renewed := a.Quota != a.closedQuota || !a.ExpiresAt.Equal(a.closedExpiry)
		reopenAt := p.ReopenMin
		if !renewed {
			var dem float64
			for _, v := range vs {
				dem += v.vDem
			}
			reopenAt = max(p.ReopenMin, p.FinishMin, toBytes(dem*p.FinishTime.Seconds()))
		}
		// A figure still in flight from before the close is not ours to
		// hand out again (Replica.closePeak).
		if avail-holdAll >= reopenAt && (renewed || a.settled(vs)) {
			a.Closed, a.closeWatched = false, false
		}
	}
	// An end that passes on a Grant already closed moves the close to it
	// (F-027-dy): the close is written again, and billing reads it as ended.
	if a.Closed && expired && !a.ExpiresAt.Equal(a.closedExpiry) {
		a.closedQuota, a.closedExpiry = a.Quota, a.ExpiresAt
	}
	anyActive, activeBlocked := false, true
	for _, v := range vs {
		if v.active && v.healthy {
			anyActive = true
			if !v.blocked {
				activeBlocked = false
			}
		}
	}
	// Close only when it helps: the balance is really gone (the passive
	// panel limit is lagging), or every active replica already ran dry and
	// what is left is too small to be worth reopening (no cut/resume flap).
	// NOT when avail<=0: that only means "the rest will be eaten during the
	// panel's lag", which the leases already account for; closing then would
	// under-deliver by rate×lag.
	remaining := a.Quota - a.Used
	finish := max(p.FinishMin, toBytes(totNow*p.FinishTime.Seconds()))
	if !a.Closed && (expired || remaining <= 0 || (anyActive && activeBlocked && avail < finish)) {
		a.Closed, a.closedQuota, a.closedExpiry = true, a.Quota, a.ExpiresAt
		a.closeWatched, a.closedAt = true, now
	}
	if a.Closed {
		a.closedUsed = a.Used
		a.planClose(now, p, vs, &res)
		return res
	}

	// ---- allocate ----------------------------------------------------------
	var W []*view
	for _, v := range vs {
		if !v.healthy {
			continue // frozen: its hold stays counted, nothing is written
		}
		if !v.writable {
			a.planReactive(now, p, v, &res)
			continue
		}
		W = append(W, v)
	}

	tEnd := math.Inf(1)
	if totNow > 0 {
		tEnd = float64(avail) / totNow
	}
	// Budget frozen on unreachable panels is not ours to hand out.
	var frozen Bytes
	var totW float64
	for _, v := range vs {
		if !v.healthy {
			frozen += v.hold
		}
	}
	for _, v := range W {
		if v.enabled && v.active {
			totW += v.vNow
		}
	}
	availW := avail - frozen
	if len(W) > 0 {
		hMax := p.Horizon
		for _, v := range W {
			if v.active {
				hMax = max(hMax, v.H)
			}
		}
		res.Endgame = tEnd < hMax.Seconds()
		if res.Endgame && totW > 0 {
			a.targetsEndgame(W, availW, totW, p)
		} else {
			a.targetsNormal(W, availW, p)
		}
		a.settle(now, p, W, avail-holdAll, res.Endgame, &res)
	}
	a.hints(now, p, vs, tEnd, &res)
	return res
}

// targetsNormal: plenty of balance left. Give active replicas rate×horizon
// and spread everything else over all replicas (idle ones included), so a
// device switching to an idle config finds a real lease there (cold start)
// and big plans need almost no writes.
func (a *Account) targetsNormal(W []*view, avail Bytes, p Params) {
	pool := float64(avail) * (1 - p.ReserveFrac)
	var D float64
	for _, v := range W {
		if v.active {
			D += v.vDem * v.H.Seconds()
		}
	}
	scale := 1.0
	if D > pool && D > 0 {
		scale = pool / D
	}
	// Surplus: most goes to active replicas in proportion to demand (so a
	// busy config rarely needs a top-up + donor shrink = 2 writes); a share
	// goes to idle ones so a device switching config finds a real lease.
	nIdle := 0
	for _, v := range W {
		if !v.active {
			nIdle++
		}
	}
	surplus := math.Max(pool-D, 0)
	idleExtra, actFrac := 0.0, 0.0
	switch {
	case nIdle == len(W): // nobody active: split evenly
		idleExtra = surplus / float64(nIdle)
	case nIdle == 0:
		actFrac = 1
	default:
		idleExtra = surplus * p.IdleSurplusFrac / float64(nIdle)
		actFrac = 1 - p.IdleSurplusFrac
	}
	peak := math.Max(a.PeakRate, p.PriorRate)
	floor := max(p.MinLease, toBytes(peak*p.SwitchCover.Seconds()))
	floor = min(floor, max(toBytes(pool/float64(len(W))), p.MinLease))

	for _, v := range W {
		t := idleExtra
		if v.active {
			need := v.vDem * v.H.Seconds()
			t = need*scale + surplus*actFrac*need/D
		}
		v.target = min(max(toBytes(t), floor), p.maxLease(v.r.Panel))

		effHold := v.hold - toBytes(v.vNow*v.pollAge.Seconds())
		low := max(toBytes(v.vDem*p.LowWater.Seconds()), p.MinLease/2)
		v.floor = toBytes(v.vNow*(v.pollAge+p.WriteLatency).Seconds()) + low

		switch {
		case v.blocked:
			v.setWant(v.target, PRegrant, "regrant")
		case effHold < low/2:
			if v.target > v.hold {
				v.setWant(v.target, PRegrant, "starving")
			}
		case effHold < low:
			if v.target >= v.hold+p.MinStep {
				v.setWant(v.target, PTopUp, "topup")
			}
		}
	}
}

// targetsEndgame: the balance runs out within the horizon. Split what is
// left in proportion to current rates so all active replicas run dry at the
// same moment; idle replicas keep a small tail so a device that switches to
// them is not cut (a blocked replica cannot reveal demand).
func (a *Account) targetsEndgame(W []*view, avail Bytes, totNow float64, p Params) {
	idleN := 0
	for _, v := range W {
		if !v.active {
			idleN++
		}
	}
	var tail Bytes
	if idleN > 0 {
		tail = max(min(p.IdleTail, toBytes(float64(avail)*0.1/float64(idleN))), 0)
	}
	act := float64(avail) - float64(tail)*float64(idleN)
	tauStar := act / totNow
	tol := math.Max(p.EndgameTol.Seconds(), p.EndgameTolFrac*tauStar)
	// Rewriting a lease that runs out before the write lands only causes a
	// cut-and-regrant flap; below this we just let it finish.
	canRebalance := tauStar > 2*(p.MinPoll+p.WriteLatency).Seconds()

	for _, v := range W {
		v.floor = toBytes(v.vNow * (v.pollAge + p.WriteLatency).Seconds())
		if v.active {
			alloc := max(toBytes(act*v.vNow/totNow), 0)
			v.target = alloc
			tau := float64(v.hold) / v.vNow
			switch {
			case v.blocked && alloc >= p.FinishMin:
				v.setWant(alloc, PRegrant, "endgame-regrant")
			case canRebalance && math.Abs(tau-tauStar) > tol:
				v.setWant(alloc, PTopUp, "endgame-split")
			}
			continue
		}
		v.target = tail
		switch {
		case v.blocked && tail >= p.MinLease/2:
			v.setWant(tail, PRegrant, "idle-tail")
		case v.hold > tail+p.MinStep:
			v.setWant(tail, PRebalance, "idle-reclaim")
		}
	}
}

// settle turns wants into writes, respecting hysteresis, write gaps and —
// crucially — the budget: grows are paid only from budget that is free right
// now; if that is not enough, donors are shrunk and the rest of the grow
// happens on the next pass, after the panel confirmed the shrink.
func (a *Account) settle(now time.Time, p Params, W []*view, free Bytes, endgame bool, res *PlanResult) {
	gap := p.MinWriteGap
	if endgame {
		gap = p.EndgameGap
	}
	recent := func(r *Replica, d time.Duration) bool {
		return !r.LastWriteAt.IsZero() && now.Sub(r.LastWriteAt) < d
	}

	var grows []*view
	var needed Bytes
	for _, v := range W {
		if !v.hasWant {
			continue
		}
		r := v.r
		if r.Pending() && recent(r, p.DriftAfter) {
			v.hasWant = false // a write is in flight; the queue has the latest
			continue
		}
		if v.prio != PRegrant && recent(r, gap) {
			v.hasWant = false
			continue
		}
		switch {
		case v.want < v.hold:
			if v.hold-v.want < p.MinStep && v.want > 0 {
				v.hasWant = false
				continue
			}
			a.emit(res, now, r, r.Counter+v.want, true, v.prio, v.reason)
		case v.want > v.hold || v.blocked:
			v.need = v.want - v.hold
			grows = append(grows, v)
			needed += v.need
		default:
			v.hasWant = false
		}
	}

	// Donors: shrink over-provisioned replicas if grows need more than is
	// free, or if the invariant is already violated (lag estimate grew…).
	deficit := needed - free
	if free < 0 {
		deficit = max(deficit, -free)
	}
	if deficit > 0 {
		var donors []*view
		for _, v := range W {
			if v.hasWant || recent(v.r, gap) || (v.r.Pending() && recent(v.r, p.DriftAfter)) {
				continue
			}
			// normally ignore crumbs (MinStep), but near the end the deficit
			// itself is a crumb and must still be collectable
			if ex := v.hold - max(v.target, v.floor); ex >= min(p.MinStep, deficit) && ex >= MB {
				donors = append(donors, v)
			}
		}
		sort.Slice(donors, func(i, j int) bool {
			if donors[i].active != donors[j].active {
				return !donors[i].active // idle first
			}
			return donors[i].hold-donors[i].target > donors[j].hold-donors[j].target
		})
		for _, d := range donors {
			if deficit <= 0 {
				break
			}
			take := min(d.hold-max(d.target, d.floor), deficit)
			if take < min(p.MinStep, deficit) {
				continue
			}
			a.emit(res, now, d.r, d.r.Counter+d.hold-take, true, PRebalance, "donate")
			deficit -= take
		}
	}

	// Grants, pro-rata if short. Regrants first when rounding matters.
	sort.SliceStable(grows, func(i, j int) bool { return grows[i].prio < grows[j].prio })
	budget := max(free, 0)
	factor := 1.0
	if needed > budget && needed > 0 {
		factor = float64(budget) / float64(needed)
	}
	for _, g := range grows {
		give := toBytes(float64(g.need) * factor)
		if g.hold+give < p.MinLease/2 && g.blocked {
			continue // nothing meaningful to give yet; donors will free some
		}
		if give < p.MinStep && give < g.need && !g.blocked {
			continue
		}
		if give <= 0 && !g.blocked {
			continue
		}
		a.emit(res, now, g.r, g.r.Counter+g.hold+give, true, g.prio, g.reason)
	}
}

// planReactive: panels whose per-client limit we cannot change cheaply.
// Static safety cap = balance at enable time; enforcement is our own disable
// (planClose) driven by tighter polling (hints) and a poll-interval reserve.
func (a *Account) planReactive(now time.Time, p Params, v *view, res *PlanResult) {
	r := v.r
	if r.Pending() && now.Sub(r.LastWriteAt) < p.DriftAfter {
		return
	}
	if v.blocked || !r.WantEnabled {
		a.emit(res, now, r, r.Counter+(a.Quota-a.Used), true, PRegrant, "reactive-enable")
	}
}

// settled: a close this process took has nothing left in flight — Used did
// not move since the last plan that kept it, every write has landed, and
// every reading describes a panel tick past the close plus its lag.
func (a *Account) settled(vs []*view) bool {
	if !a.closeWatched || a.Used != a.closedUsed {
		return false
	}
	for _, v := range vs {
		r := v.r
		if !r.Exists && !r.Pending() && r.LimitPeak == 0 {
			continue // no client, nothing in flight: it serves nothing
		}
		if r.Pending() || r.LimitSeen != r.LimitWant || !r.effAt.After(a.closedAt.Add(v.lag)) {
			return false
		}
	}
	return true
}

func (a *Account) planClose(now time.Time, p Params, vs []*view, res *PlanResult) {
	res.Closed = true
	for _, v := range vs {
		r := v.r
		if !r.Exists {
			continue
		}
		drift := r.EnabledSeen && now.Sub(r.LastWriteAt) > p.DriftAfter
		if r.WantEnabled || drift {
			if v.writable && (r.Pending() || r.LimitPeak > r.LimitSeen) {
				r.closePeak = max(r.closePeak, r.LimitPeak, r.LimitSeen)
			}
			// Hard disable (not just limit=counter): removes the user from
			// xray immediately instead of waiting for the panel's job.
			a.emit(res, now, r, r.Counter, false, PClose, "close")
		}
		if v.healthy && (r.EnabledSeen || r.depl.pending) {
			res.hint(r.Panel.ID, now.Add(max(p.MinPoll, r.Panel.JobInterval+time.Second)))
		}
	}
}

func (a *Account) hints(now time.Time, p Params, vs []*view, tEnd float64, res *PlanResult) {
	// An idle config can wake up at any time at up to BurstRate; poll often
	// enough that it cannot drain its whole hold unseen. Big holds (big
	// plans) therefore need almost no polling; small ones get checked.
	peak := math.Max(a.PeakReplica, p.BurstRate)
	for _, v := range vs {
		if !v.healthy {
			continue // the breaker decides when to probe
		}
		r := v.r
		d := p.MaxPoll
		switch {
		case !v.writable:
			if v.vDem > 0 {
				d = clampDur(secs(float64(a.Quota-a.Used)/v.vDem/4), p.MinPoll, p.MaxPoll)
			}
		case v.enabled:
			rate, minP, div := v.vNow, p.MinPoll, 3.0
			if !v.active {
				rate, minP, div = peak, p.IdleMinPoll, 2
			}
			left := float64(v.hold)/rate - v.pollAge.Seconds()
			d = clampDur(secs(left/div), minP, p.MaxPoll)
		}
		if r.Pending() {
			d = min(d, max(p.WriteLatency+time.Second, p.MinPoll))
		}
		if r.depl.pending {
			d = min(d, r.Panel.JobInterval+time.Second)
		}
		if !math.IsInf(tEnd, 1) && tEnd > 0 {
			d = min(d, max(secs(tEnd/3), p.MinPoll))
		}
		res.hint(r.Panel.ID, now.Add(d))
	}
}

func (a *Account) emit(res *PlanResult, now time.Time, r *Replica, limit Bytes, enable bool, pr Priority, why string) {
	if enable && !r.WantEnabled && !r.EnabledSeen {
		// re-enabling a dead replica: its old peak is irrelevant (it cannot
		// consume until this write lands, and then the new limit applies)
		r.LimitPeak = limit
	} else {
		r.LimitPeak = max(r.LimitPeak, limit)
	}
	r.LimitWant = limit
	r.WantEnabled = enable
	r.LastWriteAt = now
	r.writePending = true
	res.Actions = append(res.Actions, Action{
		ReplicaID: r.ID, PanelID: r.Panel.ID, Create: !r.Exists,
		Limit: limit, Enable: enable, Priority: pr, Reason: why,
	})
}

func (a *Account) updatePeak(now time.Time, tot, one float64) {
	if !a.peakAt.IsZero() {
		k := math.Exp(-now.Sub(a.peakAt).Hours() * math.Ln2) // 1h half-life
		a.PeakRate *= k
		a.PeakReplica *= k
	}
	a.peakAt = now
	a.PeakRate = math.Max(a.PeakRate, tot)
	a.PeakReplica = math.Max(a.PeakReplica, one)
}

// toBytes converts a float budget safely (no overflow, no NaN).
func toBytes(f float64) Bytes {
	switch {
	case math.IsNaN(f):
		return 0
	case f > 1<<60:
		return 1 << 60
	case f < -(1 << 60):
		return -(1 << 60)
	}
	return Bytes(f)
}

func secs(s float64) time.Duration {
	if s <= 0 || math.IsNaN(s) {
		return 0
	}
	if s > 1e9 {
		s = 1e9
	}
	return time.Duration(s * float64(time.Second))
}

func clampDur(d, lo, hi time.Duration) time.Duration { return min(max(d, lo), hi) }
