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

// RestorePending marks a replica whose last write had not been seen on its
// panel when the previous process stopped (F-027-db, `writePending`). Its
// LastWriteAt is unknown, so the first poll past DriftAfter gives up waiting
// and the planner re-emits, while LimitPeak stays pessimistic until the panel
// shows the figure.
func (r *Replica) RestorePending(pending bool) { r.writePending = pending }

// RestoreClosed marks an account the planner closed before the process
// stopped (F-027-dd, `network.lease_close`), at the Quota and expiry it
// closed on and why (F-027-dz): only a renewal past them reopens it. The settled reopen of a
// close with bytes left (F-027-dx) is for a close this process watched.
func (a *Account) RestoreClosed(quota Bytes, expiresAt time.Time, why CloseReason) {
	a.Closed, a.closedQuota, a.closedExpiry, a.closedWhy = true, quota, expiresAt, why
	a.closeWatched = false
}

// ClosedOn is the Quota and expiry the account closed on, and why; ok is
// false while it is open.
func (a *Account) ClosedOn() (quota Bytes, expiresAt time.Time, why CloseReason, ok bool) {
	return a.closedQuota, a.closedExpiry, a.closedWhy, a.Closed
}
