package converge

import (
	"time"

	"network-service/internal/collect"
)

// The guard band (F-027-co). A panel cuts a client some seconds after it
// crosses its ceiling, and everything it serves in that lag lands in
// `consumedBytes` past the share — billed by nobody, because a metered block
// never buys negative headroom and a prepaid Grant is never suspended by us
// (`open-questions.md`, 2026-09-26). So the ceiling carried to a panel is the
// share less the config's own measured rate over its family's lag, and the
// overrun falls inside the bag at whatever speed the user runs.

// GuardBandBytes is what a config at rateBps (bits per second, as
// `observedRateBps` is) carries in lag. Zero for a config with no measured
// rate: it is not running, so there is no lag to cover.
func GuardBandBytes(rateBps int64, lag time.Duration) int64 {
	if rateBps <= 0 || lag <= 0 {
		return 0
	}
	return rateBps / 8 * lag.Milliseconds() / 1000
}

// GuardedAllowance is the allowance less the band, never below what the config
// has served: a band wider than what is left cuts the config now, and a figure
// under its counter would be a ceiling the panel is already past. Never above
// the allowance either, so `Σ ceilings ≤ purchasedBytes` survives it.
func GuardedAllowance(allowance, served, band int64) int64 {
	guarded := allowance - band
	floor := served
	if floor > allowance {
		floor = allowance
	}
	if guarded < floor {
		return floor
	}
	return guarded
}

// ServedBytes is what the config has carried in its lifetime, in the
// allocation's basis — the floor GuardedAllowance holds.
func ServedBytes(counters Counters, p collect.Panel, remoteID string) int64 {
	counter, seen := counters.Counter(p.ID, remoteID)
	if !seen {
		return 0
	}
	return counter.LifetimeUpBytes + counter.LifetimeDownBytes
}

// withinBand says the panel's figure already holds the band, and at most a
// quarter of it more. Every active config's rate moves every pass; rewriting
// the ceiling on each move would be a write per config per pass against a
// budget we hold ourselves to (invariant 34). A quarter is under the smallest
// top-up (`MIN_BLOCK_SECONDS`, 60 s of rate, against a 35 s band), so a
// bought block is never absorbed by it.
func withinBand(have, want, band int64) bool {
	return band > 0 && have > 0 && have <= want && want-have <= band/4
}
