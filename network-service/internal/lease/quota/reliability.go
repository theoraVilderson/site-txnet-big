package quota

import (
	"math"
	"time"
)

// Outages is a panel's outage history (SPEC weakness #21, F-027-dh): what
// PanelState.Reliability is read from. Not in the vendored code, which left
// Reliability at 1.
//
// Weight is a count of outages as of At that halves every OutageHalfLife. An
// outage adds its length in OutageUnits, at most one: a read that failed once
// and answered on the next pass is a fraction of an outage, a panel down for
// minutes is a whole one, and a long outage weighs no more than that — what
// it cost is the lease it froze, which MaxLease already bounds.
type Outages struct {
	Weight float64
	At     time.Time
}

// WeightAt is the count decayed to at.
func (o Outages) WeightAt(at time.Time, p Params) float64 {
	if o.Weight <= 0 {
		return 0
	}
	dt := at.Sub(o.At)
	if dt <= 0 || p.OutageHalfLife <= 0 {
		return o.Weight
	}
	return o.Weight * math.Exp2(-dt.Seconds()/p.OutageHalfLife.Seconds())
}

// Add records an outage of length d that ended at at.
func (o *Outages) Add(d time.Duration, at time.Time, p Params) {
	if d <= 0 {
		return
	}
	w := 1.0
	if p.OutageUnit > 0 {
		w = min(d.Seconds()/p.OutageUnit.Seconds(), 1)
	}
	o.Weight, o.At = o.WeightAt(at, p)+w, at
}

// Reliability is 1/(1+weight): one recent outage halves the panel's
// MaxLease, and a day without one gives back half of what it took.
func (o Outages) Reliability(at time.Time, p Params) float64 {
	return 1 / (1 + o.WeightAt(at, p))
}
