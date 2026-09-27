package quota

import "time"

// What a restart must keep of a TickClock (F-027-cz): the period and the
// feasible phase bins. Not in the vendored code, which kept its state in
// memory; added here so tick.go stays as vendored.

// Mask is the clock's feasible phase bins, and whether any poll has been
// observed yet (false: the mask means nothing).
func (c TickClock) Mask() (uint32, bool) { return c.mask, c.init }

// RestoreTickClock is a clock of period j that has already narrowed its phase
// to mask. A zero mask is a clock that has observed nothing.
func RestoreTickClock(j time.Duration, mask uint32) TickClock {
	return TickClock{J: j, mask: mask, init: mask != 0}
}
