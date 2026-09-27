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

// NearHorizon is how near its allowance, in seconds of its own rate, a config
// is given the band (F-027-cq). Two minutes, the horizon the retired hot loop
// judged membership on (F-027-dk): a config that cannot reach its allowance
// inside it is read by the bulk pass before it gets there.
const NearHorizon = 120 * time.Second

// NearBand is the band a config needs now: GuardBandBytes while it is within
// NearHorizon of its own rate from its allowance, and zero further out
// (F-027-cq). The lag only matters at the moment the panel cuts, and a far
// config reaches that moment through this window first — while a band on
// every running config is a write on every move of its rate (invariant 34).
func NearBand(allowance, served, rateBps int64, lag time.Duration) int64 {
	band := GuardBandBytes(rateBps, lag)
	if band == 0 || allowance-served > GuardBandBytes(rateBps, NearHorizon) {
		return 0
	}
	return band
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
