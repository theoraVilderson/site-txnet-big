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
// closed on and why (F-027-dz). A spent or ended close waits for a renewal
// past them. A guard close, which billing does not suspend, is watched from
// its first plan on and reopens once it settles (F-027-ea, rule 25).
func (a *Account) RestoreClosed(quota Bytes, expiresAt time.Time, why CloseReason) {
	a.Closed, a.closedQuota, a.closedExpiry, a.closedWhy = true, quota, expiresAt, why
	a.closeWatched, a.watchOnRestore = false, why == CloseGuard
}

// watchRestored starts watching a guard close read back after a restart
// (F-027-ea): from now, as if this process had just taken it. What the
// store says may still be in flight is held (closePeak) until a reading
// shows it, since the write that set it can predate the close.
func (a *Account) watchRestored(now time.Time, vs []*view) {
	a.watchOnRestore = false
	if !a.Closed || a.closedWhy != CloseGuard {
		return
	}
	a.closeWatched, a.closedAt, a.closedUsed = true, now, a.Used
	for _, v := range vs {
		if r := v.r; r.Pending() || r.LimitPeak > r.LimitSeen {
			r.closePeak = max(r.closePeak, r.LimitPeak, r.LimitSeen)
		}
	}
}

// Stranded: a guard close with less left than ReopenMin, the least any
// reopen takes (rule 26, F-027-ec). Without new money no panel serves the rest.
func (a *Account) Stranded(p Params) bool {
	return a.Closed && a.closedWhy == CloseGuard && a.Quota-a.Used < p.ReopenMin
}

// Spend rewrites a close as spent (F-027-ec). The lease planner calls it for
// a stranded metered Grant only, so billing reads its bag as spent; a
// package plan's guard close is left as it was (ADR-0105 (0)).
func (a *Account) Spend() {
	if a.Closed {
		a.closedWhy = CloseSpent
	}
}

// ClosedOn is the Quota and expiry the account closed on, and why; ok is
// false while it is open.
func (a *Account) ClosedOn() (quota Bytes, expiresAt time.Time, why CloseReason, ok bool) {
	return a.closedQuota, a.closedExpiry, a.closedWhy, a.Closed
}
