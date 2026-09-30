package quota

import "time"

// Observation is what one poll saw for one replica. All values are absolute
// panel values; adapters normalise units (Hiddify GB floats -> bytes, etc).
type Observation struct {
	Counter Bytes
	Limit   Bytes
	Enabled bool
	Missing bool // client not found on the panel (deleted by hand?)
	At      time.Time
}

// ObserveResult tells the caller what to persist / alert on.
type ObserveResult struct {
	Delta   Bytes
	Reset   bool // counter went backwards
	Anomaly bool // delta physically implausible
	Drift   bool // panel limit/enable differs from what we want, no write pending long
}

// MaxLinkRate bounds a believable delta (bytes/s per replica, ~10 Gbit/s).
const MaxLinkRate = 1.25e9

// Delta turns two cumulative readings into consumed bytes. A counter that
// went backwards was reset (admin reset, client recreated, backup restore):
// the whole new value is new usage.
func Delta(prev, cur Bytes) (d Bytes, reset bool) {
	if cur >= prev {
		return cur - prev, false
	}
	return cur, true
}

// Observe applies one poll result to the ledger. In production the caller
// persists (replica.Counter, account.Used) in the SAME transaction, guarded
// by "WHERE counter = prev", so a replayed poll can never double-charge.
func (a *Account) Observe(r *Replica, o Observation, driftAfter time.Duration) ObserveResult {
	var res ObserveResult
	eff := r.Panel.Clock.Effective(o.At)
	var dt time.Duration // time between the ticks the two readings describe
	if !r.effAt.IsZero() {
		dt = eff.Sub(r.effAt)
		if dt <= 0 && o.Counter != r.Counter {
			dt = o.At.Sub(r.PolledAt) // clock wrong; fall back to poll time
		}
	}

	if o.Missing {
		// Usage since the last poll is unrecoverable; it is bounded by the
		// hold we had granted, which was already inside the budget.
		r.Exists = false
		r.Counter, r.LimitSeen, r.EnabledSeen = 0, 0, false
		r.LimitWant, r.LimitPeak = 0, 0
		r.PolledAt, r.effAt = o.At, eff
		res.Drift = true
		return res
	}

	d, reset := Delta(r.Counter, o.Counter)
	if !r.Exists {
		// first sighting of a client WE created: it started at 0, so the
		// whole counter is real usage. (When adopting a pre-existing client,
		// set r.Counter to its current value and r.Exists=true beforehand.)
		d, reset = o.Counter, false
	}
	res.Delta, res.Reset = d, reset
	if dt > 0 && float64(d) > MaxLinkRate*dt.Seconds()+float64(64*MB) {
		res.Anomaly = true // still charged; flag the panel for review
	}

	wasBlocked := !r.EnabledSeen || (r.Panel.CanSetLimit && r.Counter >= r.LimitSeen)
	r.Rate.Observe(d, dt, wasBlocked || !o.Enabled, r.Panel.JobInterval)

	// --- lag calibration -------------------------------------------------
	if r.depl.pending {
		if !o.Enabled && d == 0 && dt >= r.Panel.JobInterval { // stable across a full tick
			over := o.Counter - r.depl.limit
			if r.depl.rate > 256*1024 && over >= 0 {
				r.Panel.Lag.Observe(float64(over) / r.depl.rate)
			}
			r.depl.pending = false
		} else if o.Enabled {
			r.depl.pending = false
		}
	}
	// Only trust the sample if the rate was really measured before the cut
	// (>=2 samples since waking): an under-read rate inflates lag a lot.
	if r.Exists && r.EnabledSeen && !o.Enabled && r.WantEnabled && !reset &&
		r.Panel.CanSetLimit && o.Counter >= o.Limit && r.Rate.N >= 2 && !r.Rate.Warming() {
		// the panel cut it by itself: limit reached
		r.depl.pending = true
		r.depl.limit = o.Limit
		r.depl.rate = r.Rate.Now()
	}

	// Censored sample: the panel is still serving although the counter is
	// past the limit. Its lag is AT LEAST (over / rate). If that already
	// exceeds our estimate, learn it now — otherwise a panel much slower
	// than we think is never calibrated, because we hard-close it first.
	if o.Enabled && r.Panel.CanSetLimit && o.Limit > 0 && o.Counter > o.Limit &&
		!r.depl.lbTaken && r.Rate.N >= 2 && !r.Rate.Warming() && r.Rate.Now() > 256*1024 {
		lb := float64(o.Counter-o.Limit) / r.Rate.Now()
		if lb > r.Panel.Lag.Reserve(0).Seconds() {
			r.Panel.Lag.Observe(lb)
		}
		r.depl.lbTaken = true
	}
	if o.Counter < o.Limit {
		r.depl.lbTaken = false
	}

	a.Used += d
	r.Exists = true
	r.Counter = o.Counter
	r.LimitSeen = o.Limit
	r.EnabledSeen = o.Enabled
	r.PolledAt = o.At
	if dt > 0 || r.effAt.IsZero() {
		r.effAt = eff
	}

	// --- pending-write bookkeeping ----------------------------------------
	if o.Limit > r.LimitPeak {
		r.LimitPeak = o.Limit // someone raised it by hand: be pessimistic
	}
	if reset {
		// our absolute limits referred to the old counter; re-plan from here
		r.LimitWant = o.Limit
		r.LimitPeak = o.Limit
	}
	if r.landed(o.Limit, o.Enabled, o.Counter) {
		r.LimitPeak = o.Limit
		r.writePending = false
	}
	if o.Limit >= r.closePeak || reset {
		r.closePeak = 0 // the write in flight at the close has landed
	}
	if r.Pending() && o.At.Sub(r.LastWriteAt) > driftAfter {
		res.Drift = true
		r.writePending = false // give up waiting; the planner re-emits
	}
	return res
}

// ConfirmWrite is called by the writer when the panel acknowledged a write.
// It lets a confirmed shrink free budget immediately instead of waiting for
// the next poll. Writes per replica are serialised, so this is safe.
func (a *Account) ConfirmWrite(r *Replica, limit Bytes, enabled bool) {
	r.Exists = true
	r.LimitSeen = limit
	r.EnabledSeen = enabled && limit > r.Counter
	if r.landed(limit, enabled, r.Counter) {
		r.LimitPeak = limit
		r.writePending = false
	}
}
