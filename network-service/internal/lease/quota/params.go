package quota

import "time"

// Params are the tunables. Defaults are a good starting point; tune them
// against the metrics in the spec (overshoot, writes/active-user/hour,
// false-cut seconds, 429 rate).
type Params struct {
	Horizon    time.Duration // lease = rate × horizon for low-balance users
	MaxHorizon time.Duration // horizon may stretch up to this when a panel is write-limited
	LowWater   time.Duration // top up when less than this much traffic is left on a replica

	MinLease Bytes // smallest lease worth granting
	MaxLease Bytes // cap per replica (× panel reliability)
	MinStep  Bytes // hysteresis: ignore changes smaller than this

	ReserveFrac     float64 // share of balance kept unallocated for instant top-ups
	IdleSurplusFrac float64 // share of the surplus parked on idle replicas
	IdleRate        float64 // bytes/s under which a replica counts as idle
	IdleTail        Bytes   // lease kept on idle replicas during the endgame
	SwitchCover     time.Duration

	EndgameTol     time.Duration // rebalance endgame only if depletion times differ more than this…
	EndgameTolFrac float64       // …or this fraction of the remaining time

	MinWriteGap  time.Duration // non-urgent writes per replica at most this often
	EndgameGap   time.Duration
	WriteLatency time.Duration

	ReopenMin  Bytes
	FinishMin  Bytes
	FinishTime time.Duration

	PriorRate   float64 // bytes/s assumed for users with no history
	BurstRate   float64 // bytes/s an idle config could suddenly start at (poll cadence for idle holds)
	MinPoll     time.Duration
	IdleMinPoll time.Duration
	MaxPoll     time.Duration
	DriftAfter  time.Duration

	LagZ float64 // lag reserve = mean + LagZ·σ (see Lag.Reserve)

	OutageUnit     time.Duration // an outage this long counts as one (see Outages)
	OutageHalfLife time.Duration // a panel's outage count halves this often
}

func DefaultParams() Params {
	return Params{
		Horizon:    3 * time.Minute,
		MaxHorizon: 30 * time.Minute,
		LowWater:   60 * time.Second,

		MinLease: 16 * MB,
		MaxLease: 20 * GB,
		MinStep:  16 * MB,

		ReserveFrac:     0.15,
		IdleSurplusFrac: 0.3,
		IdleRate:        8 * 1024,
		IdleTail:        32 * MB,
		SwitchCover:     20 * time.Second,

		EndgameTol:     15 * time.Second,
		EndgameTolFrac: 0.2,

		MinWriteGap:  90 * time.Second,
		EndgameGap:   20 * time.Second,
		WriteLatency: 2 * time.Second,

		ReopenMin:  8 * MB,
		FinishMin:  8 * MB,
		FinishTime: 5 * time.Second,

		PriorRate:   1.5 * float64(MB),
		BurstRate:   12.5 * float64(MB), // 100 Mbit/s
		MinPoll:     5 * time.Second,
		IdleMinPoll: 20 * time.Second,
		MaxPoll:     5 * time.Minute,
		DriftAfter:  2 * time.Minute,

		LagZ: 0,

		OutageUnit:     5 * time.Minute,
		OutageHalfLife: 24 * time.Hour,
	}
}

// horizon stretches the lease horizon on panels that cannot take many
// writes: with A active replicas and W writes/s, each replica may be written
// at most every 2A/W seconds, so leases must last at least that long.
func (p Params) horizon(pn *PanelState) time.Duration {
	h := p.Horizon
	if pn.WriteRate > 0 && pn.ActiveReplicas > 0 {
		need := p.LowWater + time.Duration(2*float64(pn.ActiveReplicas)/pn.WriteRate*float64(time.Second))
		h = max(h, need)
	}
	return min(h, p.MaxHorizon)
}

func (p Params) maxLease(pn *PanelState) Bytes {
	rel := pn.Reliability
	if rel <= 0 || rel > 1 {
		rel = 1
	}
	return max(Bytes(float64(p.MaxLease)*rel), p.MinLease)
}
