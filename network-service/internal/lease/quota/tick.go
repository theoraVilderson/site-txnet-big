package quota

import (
	"math/bits"
	"time"
)

// TickClock learns WHEN a panel refreshes its counters.
//
// Panels (3x-ui traffic job, Marzban record-usage job, …) move every
// counter at the same periodic tick. A reading taken at time t therefore
// describes usage up to the last tick before t, not up to t. Using poll time
// as the timestamp makes rates swing ±50–100% (a 5 s poll window may contain
// a full 10 s step, or none) — found in simulation, it caused both
// starvation and 12% overshoot.
//
// Every poll tells us whether a tick happened in (prevPoll, now]: some
// counter moved => yes; nothing moved while clients were active => no. All
// clients on a panel share the tick, so one panel pins its phase within a
// few polls. Phase is tracked as a bitmask of feasible bins (resolution
// J/32). If observations contradict (panel not periodic, restarted, clock
// jump), it restarts from the latest observation; if it never converges the
// clock stays "unknown" and callers fall back to poll time.
type TickClock struct {
	J    time.Duration
	mask uint32
	init bool
}

const tickBins = 32

func NewTickClock(j time.Duration) TickClock { return TickClock{J: j} }

func (c *TickClock) full() uint32 { return ^uint32(0) }

// Observe records one poll interval. changed: some counter moved; active:
// some client on the panel was consuming (otherwise "no change" says nothing).
func (c *TickClock) Observe(prev, now time.Time, changed, active bool) {
	if c.J <= 0 || prev.IsZero() || !now.After(prev) || (!changed && !active) {
		return
	}
	if !c.init {
		c.mask, c.init = c.full(), true
	}
	if now.Sub(prev) >= c.J {
		return // a tick certainly happened; no information
	}
	var m uint32
	for b := 0; b < tickBins; b++ {
		if c.lastTick(now, c.binPhase(b)).After(prev) {
			m |= 1 << b
		}
	}
	if !changed {
		m = ^m
	}
	if nm := c.mask & m; nm != 0 {
		c.mask = nm
	} else {
		c.mask = m
	}
}

// Known: phase pinned to within a quarter of J.
func (c *TickClock) Known() bool {
	return c.init && bits.OnesCount32(c.mask) <= tickBins/4
}

// Effective maps a poll time to the tick its readings describe.
func (c *TickClock) Effective(t time.Time) time.Time {
	if !c.Known() {
		return t
	}
	return c.lastTick(t, c.phase())
}

func (c *TickClock) binPhase(b int) time.Duration {
	return time.Duration((int64(b)*2 + 1) * c.J.Nanoseconds() / (2 * tickBins))
}

func (c *TickClock) lastTick(t time.Time, phase time.Duration) time.Time {
	ns, j := t.UnixNano(), c.J.Nanoseconds()
	off := (ns - phase.Nanoseconds()) % j
	if off < 0 {
		off += j
	}
	return time.Unix(0, ns-off)
}

// phase: middle of the feasible arc (feasible bins are contiguous mod 32).
func (c *TickClock) phase() time.Duration {
	start := 0
	for b := 0; b < tickBins; b++ { // first set bin after a clear one
		if c.mask&(1<<b) == 0 && c.mask&(1<<((b+1)%tickBins)) != 0 {
			start = (b + 1) % tickBins
			break
		}
	}
	n := bits.OnesCount32(c.mask)
	mid := (start + (n-1)/2) % tickBins
	return c.binPhase(mid)
}

// AlignPoll turns "I want fresh data by `want`" into the best poll time:
// just after the last panel tick before `want` (data only changes at ticks,
// so polling between ticks is wasted). Never earlier than one tick after
// lastPoll. Falls back to `want` while the phase is unknown.
func (c *TickClock) AlignPoll(want, lastPoll time.Time, guard time.Duration) time.Time {
	if !c.Known() {
		return want
	}
	ph := c.phase()
	t := c.lastTick(want, ph).Add(guard)
	if !t.After(lastPoll) {
		t = c.lastTick(lastPoll, ph).Add(c.J + guard)
	}
	return t
}

// MidTick is the first time after `after` that lies halfway between two
// ticks: where a poll still observes something once polls are aligned (SPEC
// §5 — an aligned poll only ever sees the tick it was aligned to, so a phase
// that moved goes unseen). Returns `after` while the phase is unknown.
func (c *TickClock) MidTick(after time.Time) time.Time {
	if !c.Known() {
		return after
	}
	t := c.lastTick(after, c.phase()).Add(c.J / 2)
	if !t.After(after) {
		t = t.Add(c.J)
	}
	return t
}

// SinceTick is how far t lies past the last tick; false while the phase is
// unknown.
func (c *TickClock) SinceTick(t time.Time) (time.Duration, bool) {
	if !c.Known() {
		return 0, false
	}
	return t.Sub(c.lastTick(t, c.phase())), true
}
