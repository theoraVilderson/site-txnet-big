package quota

import (
	"math"
	"time"
)

// Lag estimates a panel's enforcement lag E: the time between a client
// crossing its limit and the panel actually cutting it. Everything the user
// consumes during E is overshoot, so the planner reserves rate×E.
//
// It calibrates itself: every time a replica hits its limit we later read
// how far the counter went past the limit (overshoot) and divide by the rate
// just before (seconds of lag). We keep an EWMA of mean and variance.
//
// The reserve uses mean + z·σ (Params.LagZ). z=0 makes over- and under-shoot
// equally likely (zero expected loss once debt/credit carry-over is on);
// z=1 trades a little under-delivery for rarely over-delivering.
type Lag struct {
	Init  time.Duration // used until the first sample
	Floor time.Duration
	Ceil  time.Duration

	Mean float64 // seconds
	Var  float64
	N    int
}

// NewLag gives a sane starting estimate from the panel's job interval.
func NewLag(job time.Duration) Lag {
	return Lag{
		Init:  job * 3 / 4, // tick phase averages J/2, plus some panel-side delay
		Floor: job / 4,
		Ceil:  10 * time.Minute,
	}
}

// Observe adds one sample (seconds of lag).
func (l *Lag) Observe(sec float64) {
	sec = math.Max(0, math.Min(sec, l.Ceil.Seconds()))
	if l.N == 0 {
		l.Mean = sec
		l.Var = (sec * 0.25) * (sec * 0.25)
	} else {
		const a = 0.2
		d := sec - l.Mean
		l.Mean += a * d
		l.Var = (1 - a) * (l.Var + a*d*d)
	}
	l.N++
}

// Reserve is the lag the planner budgets for: mean + z·σ.
func (l Lag) Reserve(z float64) time.Duration {
	if l.N == 0 {
		return l.Init
	}
	s := l.Mean + z*math.Sqrt(l.Var)
	d := time.Duration(s * float64(time.Second))
	return min(max(d, l.Floor), l.Ceil)
}
