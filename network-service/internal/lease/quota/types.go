// Package quota is the traffic-lease engine: it keeps the authoritative usage
// ledger for every subscription and decides, per replica (one meter on one
// panel), what limit the panel should enforce so that the sum of everything a
// user can still consume never exceeds what they paid for.
//
// The package is pure: no I/O, no goroutines, no clocks. Pollers feed it
// observations, it returns actions and poll deadlines. That keeps it testable
// (see ../sim) and lets you shard it by user id without locks.
package quota

import "time"

// Bytes is a byte count. Signed on purpose: budgets can go negative (debt).
type Bytes = int64

const (
	KB Bytes = 1 << 10
	MB Bytes = 1 << 20
	GB Bytes = 1 << 30
)

// PanelState is the planner's view of one panel. It is shared by every
// replica living on that panel and is updated by the poller/gate layer.
type PanelState struct {
	ID string

	// Healthy is false while the circuit breaker is open or polls fail.
	// Leases on an unhealthy panel are frozen: counted, never grown.
	Healthy bool

	// CanSetLimit: per-client limit is writable (lease mode). When false the
	// replica runs in reactive mode (static cap + disable on exhaustion).
	CanSetLimit bool

	// JobInterval is how often the panel refreshes counters / enforces
	// limits internally (3x-ui ~10s, Marzban ~10s, Hiddify slower).
	JobInterval time.Duration

	// Lag is the self-calibrating enforcement-lag estimator (see lag.go).
	Lag Lag

	// Clock learns the panel's counter-refresh tick (see tick.go). The
	// poller calls Clock.Observe once per poll, before Account.Observe.
	Clock TickClock

	// WriteRate is the sustainable writes/sec the gate currently allows.
	// ActiveReplicas is how many replicas on this panel are consuming.
	// Together they stretch the lease horizon so writes never exceed what
	// the panel can take (see Params.horizon).
	WriteRate      float64
	ActiveReplicas int

	// PollInterval is the current poll interval; used for reactive replicas.
	PollInterval time.Duration

	// Reliability in (0,1]; flaky panels get smaller max leases so an outage
	// freezes less budget. 0 is treated as 1. Read from Outages each plan.
	Reliability float64
	Outages     Outages
}

// Replica is one meter on one panel for one subscription:
//   - Marzban/Marzneshin/Hiddify: the user on that panel (all inbounds share it)
//   - 3x-ui / x-ui: one client (unique email) on one inbound
type Replica struct {
	ID    int64
	Panel *PanelState

	Exists bool // the client exists on the panel

	// Last observation from the panel.
	Counter     Bytes // cumulative usage counter
	LimitSeen   Bytes // absolute limit the panel currently enforces
	EnabledSeen bool
	PolledAt    time.Time
	effAt       time.Time // panel tick the last reading describes

	// What we asked for. LimitPeak is the pessimistic limit used for the
	// safety invariant: max(LimitSeen, every LimitWant not yet confirmed).
	// A shrink therefore frees budget only once the panel confirms it.
	LimitWant    Bytes
	LimitPeak    Bytes
	WantEnabled  bool
	LastWriteAt  time.Time
	writePending bool // a write we emitted has not been seen on the panel yet

	// closePeak is the highest figure a write in flight when the account
	// closed may still land (F-027-dx). The close writes the counter, which
	// can equal what the panel already shows, so a reading of it cannot tell
	// the close from the older write still queued; the figure stays in Hold
	// until a reading shows it or more.
	closePeak Bytes

	Rate Rate

	depl struct { // pending lag-calibration sample
		pending bool
		limit   Bytes
		rate    float64
		lbTaken bool // lower-bound sample already taken for this crossing
	}
}

// Hold is the budget this replica could still consume without us seeing it:
// pessimistic limit minus last observed counter. 0 if disabled and we do not
// want it enabled.
func (r *Replica) Hold() Bytes {
	if !r.Panel.CanSetLimit {
		return 0
	}
	stale := max(r.closePeak-r.Counter, 0)
	if !r.EnabledSeen && !r.WantEnabled {
		return stale
	}
	if !r.Exists && r.LimitPeak == 0 {
		return stale
	}
	return max(r.LimitPeak-r.Counter, stale)
}

// Pending reports whether a write we emitted has not landed yet. (A panel
// disabling a client on its own at the limit is NOT a pending write.)
func (r *Replica) Pending() bool { return r.writePending }

// landed: the panel shows the state we asked for. A client we enabled that
// the panel already cut at its (new) limit also counts as landed.
func (r *Replica) landed(limit Bytes, enabled bool, counter Bytes) bool {
	return limit == r.LimitWant && (enabled == r.WantEnabled || (r.WantEnabled && counter >= limit))
}

// CloseReason is why the planner closed an account (F-027-dz): billing
// suspends a prepaid Grant on `spent` or `ended`, never on `guard`, which is
// the blocked branch with bytes still paid. The values are
// `network.LeaseCloseReason`'s.
type CloseReason string

const (
	CloseSpent CloseReason = "spent" // Quota − Used ≤ 0
	CloseEnded CloseReason = "ended" // the end passed; wins over spent
	CloseGuard CloseReason = "guard" // every active replica blocked, too little left to finish on
)

// Account is one subscription (the thing the end user bought).
//
// Quota and Used are cumulative over the subscription's whole life. A renewal
// is just Quota += purchased, so any credit (under-use) or debt (over-use)
// from the previous period carries over automatically — nobody loses bytes.
type Account struct {
	ID        string
	Quota     Bytes
	Used      Bytes
	ExpiresAt time.Time // zero = no expiry

	Closed       bool
	closedQuota  Bytes
	closedExpiry time.Time
	closedWhy    CloseReason
	// A close this process took (not one restored): when, and Used on the
	// last plan that kept it, so a close with bytes left can reopen once
	// what was in flight has settled (F-027-dx).
	closeWatched bool
	closedAt     time.Time
	closedUsed   Bytes
	// A guard close read back after a restart (F-027-ea): its first plan
	// watches it from then on, as if this process had taken it.
	watchOnRestore bool

	PeakRate    float64 // decayed max of the account's total raw rate
	PeakReplica float64 // decayed max of any single replica's raw rate
	peakAt      time.Time

	Replicas []*Replica
}

// Renew adds purchased bytes (and optionally a new expiry). Carry-over of
// credit/debt is implicit because Quota and Used are cumulative.
func (a *Account) Renew(add Bytes, expires time.Time) {
	a.Quota += add
	if !expires.IsZero() {
		a.ExpiresAt = expires
	}
}

// Balance is what the user still has (negative = debt).
func (a *Account) Balance() Bytes { return a.Quota - a.Used }
