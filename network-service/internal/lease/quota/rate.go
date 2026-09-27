package quota

import (
	"math"
	"time"
)

const (
	fastTau = 30 * time.Second
	slowTau = 10 * time.Minute
)

// wakeRate: below this a replica is considered asleep.
const wakeRate = 8 * 1024

// Rate is a two-speed consumption estimator (bytes/s).
//
//   - Fast: attacks instantly (any higher sample replaces it) and decays with
//     a 30 s time constant. Used for "how fast is it draining right now":
//     lag reserve, endgame split, poll urgency.
//   - Slow: 10 min EWMA. Demand() = max(Fast, Slow) sizes leases so a brief
//     pause does not shrink a heavy user's lease.
//
// Rules that fix classic estimator bugs (all found in simulation):
//  1. Panels move counters in steps (one per JobInterval J). Windows are
//     measured between the panel ticks the readings describe (TickClock),
//     and a sample is taken only when the counter changed. Arbitrary poll
//     windows read 0 (false idle) or a whole step in half the time (2× spike).
//  2. No change for 2·J = idle: Fast drops to 0 at once (Slow decays).
//  3. While the replica was blocked (disabled / at its limit) a low sample is
//     ignored: zero then means "cut", not "idle".
//  4. First sample after waking: usage happened after the previous poll,
//     so window = max(this poll interval, J), not the whole idle period
//     (10× under-read, starves the replica) and not just J (30× over-read
//     when polls are sparse, triggers a false endgame).
type Rate struct {
	Fast float64
	Slow float64

	accD Bytes
	accT time.Duration
	warm int // samples left in the "just woke up" state
	N    int // samples since the replica last woke up
}

// Observe feeds one poll delta.
func (r *Rate) Observe(d Bytes, dt time.Duration, blocked bool, J time.Duration) {
	if dt <= 0 {
		return
	}
	r.accD += d
	r.accT += dt
	var win time.Duration
	switch {
	case d > 0:
		// A change means >=1 tick, and one tick carries J worth of usage, so
		// the window is at least J (when the TickClock is known, accT is
		// already a whole number of ticks; this guards the fallback).
		win = max(r.accT, J)
		if r.Fast <= wakeRate && win > J { // rule 4
			// Usage started after the previous poll (which saw no change),
			// so it happened within THIS observation's window, not within
			// one tick: using J when polls are sparse over-reads 30×.
			win = max(dt, J)
		}
	case d == 0 && r.accT >= 2*J:
		win = r.accT // rule 2
	default:
		return
	}
	inst := float64(r.accD) / win.Seconds()
	r.accD, r.accT = 0, 0

	if blocked && inst < r.Fast { // rule 3
		return
	}
	if r.warm > 0 {
		r.warm--
	}
	if r.Fast <= wakeRate && inst > wakeRate {
		r.warm, r.N = 2, 0
	}
	if inst > wakeRate {
		r.N++
	}
	switch {
	case inst >= r.Fast:
		r.Fast = inst
	case d == 0:
		// no step for 2 ticks: the device left (switched config / stopped).
		// Drop Fast at once so the endgame split moves budget to where the
		// traffic went; Slow keeps the long-term demand for lease sizing.
		r.Fast = 0
	default:
		r.Fast += alpha(win, fastTau) * (inst - r.Fast)
	}
	r.Slow += alpha(win, slowTau) * (inst - r.Slow)
}

// Warming reports that the replica just started consuming and its estimate
// is not trustworthy yet.
func (r Rate) Warming() bool { return r.warm > 0 }

// Now is the current drain rate.
func (r Rate) Now() float64 { return r.Fast }

// Demand is the rate used for sizing leases.
func (r Rate) Demand() float64 { return math.Max(r.Fast, r.Slow) }

func alpha(dt, tau time.Duration) float64 {
	return 1 - math.Exp(-dt.Seconds()/tau.Seconds())
}
