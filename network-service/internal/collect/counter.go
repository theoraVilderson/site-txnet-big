package collect

import (
	"time"

	"network-service/internal/driver"
)

// Counter mirrors `network.config_counter_state`: the last **raw** figures
// read off the source, not a total, which is what makes a counter going
// backward a reset rather than negative usage.
type Counter struct {
	Semantics         driver.CounterSemantics
	LastUpBytes       int64
	LastDownBytes     int64
	LifetimeUpBytes   int64
	LifetimeDownBytes int64
	LastObservedAt    time.Time
	ResetCount        int
	LastResetAt       time.Time
	// LimitOriginID is where the panel's own limit counts from, as the
	// reading named it (driver.ClientUsage.LimitOrigin), and LimitOriginBytes
	// what this counter read when that origin was first seen: the limit has
	// counted the raw figure less it (F-027-du-b). LimitOriginAt is that
	// pass. Moving it is no reset — the bill reads the raw figure, which did
	// not go back — so it never reaches containment's mass-reset count.
	LimitOriginID    string
	LimitOriginBytes int64
	LimitOriginAt    time.Time
}

// Restated is whether the pass at `at` moved this counter's origin — a
// reset, or a new limit origin — so the ceiling the panel holds is in the old
// one, and is written again on this turn whatever the plan did (ADR-0072).
func Restated(c Counter, at time.Time) bool {
	moved := func(t time.Time) bool { return !t.IsZero() && t.Equal(at) }
	return moved(c.LastResetAt) || moved(c.LimitOriginAt)
}

// LimitCounted is what the panel's own limit has counted of this raw figure:
// the figure less the origin it counts from, never below zero.
func (c Counter) LimitCounted() int64 {
	return max(c.LastUpBytes+c.LastDownBytes-c.LimitOriginBytes, 0)
}

// withOrigin takes the limit origin a reading names, if it is a new one: at
// that reading's figure, so a link made between two reads is measured from
// the later — the limit has counted at least what is left, the safe side. A
// reading that names none leaves the cursor's.
func withOrigin(c Counter, reading driver.ClientUsage, at time.Time) Counter {
	if reading.LimitOrigin == "" || reading.LimitOrigin == c.LimitOriginID {
		return c
	}
	c.LimitOriginID, c.LimitOriginBytes, c.LimitOriginAt = reading.LimitOrigin, reading.UpBytes+reading.DownBytes, at
	return c
}
