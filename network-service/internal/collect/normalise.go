// Package collect is the bulk collection loop and the normaliser under it
// (F-027-l, ADR-0074).
//
// One pass asks every pull panel for its whole population in one request,
// turns three different counter arithmetics into one delta stream, and
// accounts for every byte it read: billed, quarantined, or written down as
// usage no config claims. Past this package nothing knows which family a byte
// came from — that is the promise ADR-0074 bought by making a panel declare
// its semantics, and it is what stops deduplication, the plausibility cap and
// the ceiling from being written six times.
//
// Two rules shape everything here and neither is negotiable:
//
//   - A counter going backward is a reset, never negative usage. No negative
//     delta is ever published (ADR-0074).
//   - No measured byte is dropped (invariant 18). A figure we cannot believe
//     is quarantined, a client we cannot place is unattributed, and a pass
//     that fails leaves its cursor alone so the bytes are read again.
//
// What is deliberately not here: money, the wire, and the panel. Publishing
// the stream is F-027-m, applying it is F-027-n, the ceiling is F-027-s/t and
// the per-panel request budget is F-027-v. This package is the hard logic,
// proved against `internal/driver/fake` before any of those touch it.
package collect

import (
	"time"

	"network-service/internal/driver"
)

// QuarantineReason mirrors `network.QuarantineReason`. A quarantined figure is
// one we do not believe; it is never applied to a Grant until someone releases
// it, and it is never discarded.
type QuarantineReason string

const (
	// ReasonImplausibleVolume: more bytes than the panel's own line rate could
	// have carried in the window we measured over.
	ReasonImplausibleVolume QuarantineReason = "implausible_volume"
	// ReasonResetWithUnmeasuredBytes: a counter went backward and the figure
	// that followed is itself past the cap. The reset is what makes it
	// unverifiable, so it is named rather than filed as ordinary volume.
	ReasonResetWithUnmeasuredBytes QuarantineReason = "reset_with_unmeasured_bytes"
	// ReasonSemanticsMismatch: the cursor was computed under an arithmetic the
	// panel no longer declares, or a reading carries the wrong shape for the
	// one it does.
	ReasonSemanticsMismatch QuarantineReason = "semantics_mismatch"
	// ReasonClockWentBackward: our own clock moved back, so the window the cap
	// is measured over does not exist and the figure cannot be bounded.
	ReasonClockWentBackward QuarantineReason = "clock_went_backward"
)

// Panel is one panel as a pass needs it: its declaration, its driver, and who
// its remote clients belong to.
type Panel struct {
	ID string
	// CounterSemantics and Transport are the declaration (ADR-0074). They
	// select the arithmetic below, and a panel re-declared invalidates every
	// cursor computed under the old one.
	CounterSemantics driver.CounterSemantics
	Transport        driver.Transport
	// MaxLineRateBps is `panel.maxLineRateBps`, the ceiling on what the far
	// end could physically have carried. The column is nullable, so zero is
	// **unknown**, not zero: a panel that has not declared a line rate gets no
	// rate cap rather than a cap of nothing, because the second reading
	// quarantines every byte on it in silence.
	MaxLineRateBps int64
	// MaxRequestsPerMinute is `panel.maxRequestsPerMinute`, the budget we hold
	// ourselves to on somebody else's server. It is carried on the row rather
	// than fixed in the loop because it is the panel owner's figure, and
	// `Paced` is what turns it into behaviour (F-027-v, invariant 34).
	MaxRequestsPerMinute int
	Driver               driver.Driver
	// OwnershipType is `panel.ownershipType` and TenantID its `tenantId`, set
	// exactly when the ownership is `tenant` (invariant 9). They are carried
	// through the pass rather than joined for by the consumer, because the
	// bandwidth a panel served is a cost its owner pays (F-1002) and the
	// collector is already holding the row that says who that is.
	OwnershipType string
	TenantID      string
	// Configs maps the panel's own client id to the config that owns it, read
	// off `config.remoteId`. The convergence pass's three-key match (F-027-aa)
	// re-keys a renamed or rebuilt client's row, so the pass after it claims
	// the reading again; until then it is an Unattributed row, never nothing.
	Configs map[string]ConfigRef
}

// ConfigRef is what the pass knows about the config behind a remote client:
// which one it is, and what it speaks. The protocol rides with every delta
// (F-027-m) rather than being looked up downstream — per-protocol cost is what
// F-1002 reports on, and `traffic_raw_log` is partitioned by month, so adding
// it later is a migration over every partition.
type ConfigRef struct {
	ConfigID string
	Protocol string
}

// Delta is one config's measured traffic for one interval — the only shape
// anything downstream sees, whatever family produced it.
type Delta struct {
	PanelID   string
	ConfigID  string
	RemoteID  string
	Protocol  string
	UpBytes   int64
	DownBytes int64
	// ObservedAt is the pass's own clock, sampled when the read returned. A
	// bulk pass is one request (invariant 34), so every reading in it is one
	// moment, and one clock is what the cap is measured against.
	ObservedAt time.Time
	// SessionID is set under session semantics and empty otherwise.
	SessionID string
	// AfterReset says the counter this came from had gone backward. The bytes
	// are real; what is lost is whatever ran between the last read and the
	// reset, and that gap is a fact about this delta rather than a footnote.
	AfterReset bool
}

// Quarantine is a figure we measured and do not believe.
type Quarantine struct {
	PanelID    string
	ConfigID   string
	RemoteID   string
	UpBytes    int64
	DownBytes  int64
	ObservedAt time.Time
	Reason     QuarantineReason
}

// Unattributed is usage against a remote client no config claims. It exists so
// the bytes cannot be dropped for want of a row (invariant 24/25).
type Unattributed struct {
	PanelID          string
	RemoteIdentifier string
	UpBytes          int64
	DownBytes        int64
	ObservedAt       time.Time
}

// Result is one panel's whole pass. Everything it read is in exactly one of
// the three slices, and Advances is what the cursors become **once it has been
// published** — never before (F-027-n's exactly-once effect starts here).
type Result struct {
	PanelID string
	// OwnershipType and TenantID are the panel's, copied here so the pass is
	// self-describing on the wire (F-027-m). A Sink is handed a Result and
	// nothing else.
	OwnershipType string
	TenantID      string
	ObservedAt    time.Time
	Deltas        []Delta
	Quarantines   []Quarantine
	Unattributed  []Unattributed
	Advances      []Advance
}

// Advance is one cursor's new value. Session holds the per-session high-water
// under session semantics, and is nil otherwise.
type Advance struct {
	PanelID   string
	RemoteID  string
	SessionID string
	Counter   Counter
	Session   *SessionMark
}

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
}

// SessionMark is how much of one session's high-water mark has already left as
// a delta — `radius_session.published*Bytes` under another name. It is what
// makes a restored backup harmless: the restore brings back a session id whose
// bytes are already published, so the rise above the mark is zero.
type SessionMark struct {
	PublishedUpBytes   int64
	PublishedDownBytes int64
	LastObservedAt     time.Time
}

// Normaliser turns one panel's readings into one delta stream.
type Normaliser struct {
	Panel   Panel
	Cursors Cursors
	// MinWindow is the shortest window the plausibility cap is measured over.
	// The cap stretches with the real gap since the last reading — a collector
	// that was down for two hours must not quarantine the traffic it missed —
	// and this floor stops a pass that ran early from capping at nearly zero.
	MinWindow time.Duration
}

// Pass normalises one bulk read. It writes nothing: the caller publishes the
// Result and only then applies its Advances, so a crash between the two
// re-reads rather than loses (invariant 18).
func (n Normaliser) Pass(readings []driver.ClientUsage, at time.Time) Result {
	res := Result{
		PanelID:       n.Panel.ID,
		OwnershipType: n.Panel.OwnershipType,
		TenantID:      n.Panel.TenantID,
		ObservedAt:    at,
	}
	for _, reading := range readings {
		ref, claimed := n.Panel.Configs[reading.RemoteID]
		if !claimed {
			res.Unattributed = append(res.Unattributed, Unattributed{
				PanelID:          n.Panel.ID,
				RemoteIdentifier: reading.RemoteID,
				UpBytes:          reading.UpBytes,
				DownBytes:        reading.DownBytes,
				ObservedAt:       at,
			})
			continue
		}
		if n.Panel.CounterSemantics == driver.CounterSession {
			n.session(&res, reading, ref, at)
			continue
		}
		n.counter(&res, reading, ref, at)
	}
	return res
}

// counter is the cumulative and reset_on_read arithmetic. They differ in one
// line — what a reading means — and share everything else, which is the point
// of having one normaliser.
func (n Normaliser) counter(res *Result, reading driver.ClientUsage, ref ConfigRef, at time.Time) {
	cur, seen := n.Cursors.Counter(n.Panel.ID, reading.RemoteID)

	if seen && cur.Semantics != n.Panel.CounterSemantics {
		// The panel was re-declared. The cursor means nothing under the new
		// arithmetic, so the reading is parked and the cursor rebuilt from it
		// — one quarantined figure, not one per pass for ever.
		n.quarantine(res, ref.ConfigID, reading.RemoteID, reading.UpBytes, reading.DownBytes, at, ReasonSemanticsMismatch)
		n.adopt(res, reading, at, nil)
		return
	}
	if reading.SessionID != "" {
		// A session id under a non-session declaration is the declaration
		// being wrong about the source, which is the failure ADR-0074 exists
		// to catch before it is a plausible wrong number.
		n.quarantine(res, ref.ConfigID, reading.RemoteID, reading.UpBytes, reading.DownBytes, at, ReasonSemanticsMismatch)
		return
	}
	if !seen {
		n.adopt(res, reading, at, nil)
		return
	}

	next := cur
	next.LastUpBytes, next.LastDownBytes = reading.UpBytes, reading.DownBytes
	next.LastObservedAt = later(cur.LastObservedAt, at)

	if at.Before(cur.LastObservedAt) {
		// The window the cap is measured over does not exist. The figure is
		// kept whole and parked; the cursor still moves, or the same bytes are
		// quarantined again on every pass for ever.
		up, down := n.rise(cur, reading)
		n.quarantine(res, ref.ConfigID, reading.RemoteID, up, down, at, ReasonClockWentBackward)
		n.advance(res, reading.RemoteID, "", next, nil)
		return
	}

	up, down := n.rise(cur, reading)
	afterReset := n.Panel.CounterSemantics == driver.CounterCumulative &&
		(reading.UpBytes < cur.LastUpBytes || reading.DownBytes < cur.LastDownBytes)
	if afterReset {
		next.ResetCount++
		next.LastResetAt = at
	}

	if over, reason := n.overCap(cur.LastObservedAt, at, up, down, afterReset); over {
		n.quarantine(res, ref.ConfigID, reading.RemoteID, up, down, at, reason)
		n.advance(res, reading.RemoteID, "", next, nil)
		return
	}

	if up > 0 || down > 0 {
		res.Deltas = append(res.Deltas, Delta{
			PanelID: n.Panel.ID, ConfigID: ref.ConfigID, RemoteID: reading.RemoteID,
			Protocol: ref.Protocol, UpBytes: up, DownBytes: down,
			ObservedAt: at, AfterReset: afterReset,
		})
		next.LifetimeUpBytes += up
		next.LifetimeDownBytes += down
	}
	n.advance(res, reading.RemoteID, "", next, nil)
}

// rise is what a reading is worth under this panel's arithmetic.
//
//   - reset_on_read: the reading **is** the delta — the act of reading zeroed
//     the source, so nothing about it is cumulative.
//   - cumulative, rising: the difference from the cursor.
//   - cumulative, gone backward: a reset. The post-reset figure is whole and
//     real; the bytes between the last read and the reset were never measured
//     by anyone, so there is nothing to carry forward and nothing to subtract.
func (n Normaliser) rise(cur Counter, reading driver.ClientUsage) (up, down int64) {
	if n.Panel.CounterSemantics == driver.CounterResetOnRead {
		return reading.UpBytes, reading.DownBytes
	}
	up, down = reading.UpBytes, reading.DownBytes
	if up >= cur.LastUpBytes && down >= cur.LastDownBytes {
		return up - cur.LastUpBytes, down - cur.LastDownBytes
	}
	return up, down
}

// session is the per-session high-water arithmetic. A session counter only
// rises, and a session id we have already published against is worth only what
// it has risen above that mark — which is why a restored backup costs nothing
// here and thousands of resets on a cumulative panel (ADR-0074).
func (n Normaliser) session(res *Result, reading driver.ClientUsage, ref ConfigRef, at time.Time) {
	cur, seen := n.Cursors.Counter(n.Panel.ID, reading.RemoteID)
	if seen && cur.Semantics != n.Panel.CounterSemantics {
		n.quarantine(res, ref.ConfigID, reading.RemoteID, reading.UpBytes, reading.DownBytes, at, ReasonSemanticsMismatch)
		n.adopt(res, reading, at, n.markFor(reading, at))
		return
	}
	if reading.SessionID == "" {
		// A session panel that reports no session id cannot be told apart from
		// a restored one, which is the whole protection.
		n.quarantine(res, ref.ConfigID, reading.RemoteID, reading.UpBytes, reading.DownBytes, at, ReasonSemanticsMismatch)
		return
	}
	if !seen {
		n.adopt(res, reading, at, n.markFor(reading, at))
		return
	}

	mark, known := n.Cursors.Session(n.Panel.ID, reading.RemoteID, reading.SessionID)
	up, down := reading.UpBytes, reading.DownBytes
	if known {
		// A lower reading inside a known session is a NAS restart or a
		// restore, never negative usage: the high-water mark holds.
		up = atLeastZero(up - mark.PublishedUpBytes)
		down = atLeastZero(down - mark.PublishedDownBytes)
	}

	next := cur
	next.LastUpBytes, next.LastDownBytes = reading.UpBytes, reading.DownBytes
	next.LastObservedAt = later(cur.LastObservedAt, at)
	nextMark := SessionMark{
		PublishedUpBytes:   max64(mark.PublishedUpBytes, reading.UpBytes),
		PublishedDownBytes: max64(mark.PublishedDownBytes, reading.DownBytes),
		LastObservedAt:     at,
	}

	if at.Before(cur.LastObservedAt) {
		n.quarantine(res, ref.ConfigID, reading.RemoteID, up, down, at, ReasonClockWentBackward)
		n.advance(res, reading.RemoteID, reading.SessionID, next, &nextMark)
		return
	}
	if over, reason := n.overCap(cur.LastObservedAt, at, up, down, false); over {
		n.quarantine(res, ref.ConfigID, reading.RemoteID, up, down, at, reason)
		n.advance(res, reading.RemoteID, reading.SessionID, next, &nextMark)
		return
	}

	if up > 0 || down > 0 {
		res.Deltas = append(res.Deltas, Delta{
			PanelID: n.Panel.ID, ConfigID: ref.ConfigID, RemoteID: reading.RemoteID,
			Protocol: ref.Protocol, UpBytes: up, DownBytes: down,
			ObservedAt: at, SessionID: reading.SessionID,
		})
		next.LifetimeUpBytes += up
		next.LifetimeDownBytes += down
	}
	n.advance(res, reading.RemoteID, reading.SessionID, next, &nextMark)
}

// adopt is the first sight of a client: the reading becomes the baseline and
// nothing is published. Whatever the counter already held ran before we were
// watching, and billing it would charge a user for traffic we never measured —
// the same mistake as extrapolating past a missing Stop, made at the start
// instead of the end.
//
// Under reset_on_read the read has already spent the counter, so that one
// interval is lost rather than merely unbilled. It is the bounded loss window
// ADR-0074 accepts for a low-trust source, and it is bounded to exactly one
// pass.
func (n Normaliser) adopt(res *Result, reading driver.ClientUsage, at time.Time, mark *SessionMark) {
	n.advance(res, reading.RemoteID, reading.SessionID, Counter{
		Semantics:      n.Panel.CounterSemantics,
		LastUpBytes:    reading.UpBytes,
		LastDownBytes:  reading.DownBytes,
		LastObservedAt: at,
	}, mark)
}

// markFor is the session baseline a reading supports: a mark can only exist
// where the source named the session it belongs to.
func (n Normaliser) markFor(reading driver.ClientUsage, at time.Time) *SessionMark {
	if reading.SessionID == "" {
		return nil
	}
	return &SessionMark{
		PublishedUpBytes:   reading.UpBytes,
		PublishedDownBytes: reading.DownBytes,
		LastObservedAt:     at,
	}
}

// overCap is the stretched plausibility cap: elapsed time x line rate. The
// window is the real gap since the last reading, floored at MinWindow, so an
// outage does not turn a user's genuine backlog into a quarantine queue and a
// pass that ran early does not cap at nearly nothing.
func (n Normaliser) overCap(since, at time.Time, up, down int64, afterReset bool) (bool, QuarantineReason) {
	if n.Panel.MaxLineRateBps <= 0 {
		// Unknown, not zero. See Panel.MaxLineRateBps.
		return false, ""
	}
	window := at.Sub(since)
	if window < n.minWindow() {
		window = n.minWindow()
	}
	ceiling := int64(window.Seconds() * float64(n.Panel.MaxLineRateBps) / 8)
	if up+down <= ceiling {
		return false, ""
	}
	if afterReset {
		return true, ReasonResetWithUnmeasuredBytes
	}
	return true, ReasonImplausibleVolume
}

func (n Normaliser) minWindow() time.Duration {
	if n.MinWindow > 0 {
		return n.MinWindow
	}
	return DefaultInterval
}

func (n Normaliser) quarantine(res *Result, configID, remoteID string, up, down int64, at time.Time, reason QuarantineReason) {
	res.Quarantines = append(res.Quarantines, Quarantine{
		PanelID: n.Panel.ID, ConfigID: configID, RemoteID: remoteID,
		UpBytes: up, DownBytes: down, ObservedAt: at, Reason: reason,
	})
}

func (n Normaliser) advance(res *Result, remoteID, sessionID string, cur Counter, mark *SessionMark) {
	cur.Semantics = n.Panel.CounterSemantics
	res.Advances = append(res.Advances, Advance{
		PanelID: n.Panel.ID, RemoteID: remoteID, SessionID: sessionID,
		Counter: cur, Session: mark,
	})
}

func atLeastZero(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func later(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
