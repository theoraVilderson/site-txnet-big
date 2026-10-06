// Package panelstate is what one turn's outcome says about the panel it was
// spent on (F-027-v).
//
// The distinction it exists for is the one `driver.Fault` was built to carry:
// a `429` or a `403` is a panel that is **answering and refusing us**, and a
// `5xx` is a panel that is **failing**. They arrive the same way and mean
// opposite things, and treating them alike fails in both directions — a panel
// we were merely rude to gets quarantined, and one that is down gets hammered
// at a pass a minute. `network.PanelState` has a name for each, and this
// package is the only thing that sets them.
//
// Three rules follow, and each of them is a refusal rather than a preference:
//
//   - **A refusal is not retried through.** A blocked panel is not asked again
//     until its cool-off has run, because retrying through a ban is the
//     behaviour that makes the ban permanent and our address the one it is
//     written against. A `down` panel is read on the very next pass: nothing
//     is gained by waiting on a machine that is simply broken.
//   - **A ban carries a clock** (invariant 11). `blockedSince` is set exactly
//     while the state is `throttled_or_blocked`, set once when the refusal
//     starts and never restarted by a pass that finds it still refusing — a
//     clock reset every minute is a cool-off that never elapses.
//   - **The owner hears about it once.** A refusal is a thing a person has to
//     act on: rotate a credential, unban an address, raise a budget. One
//     alert per ban, not one per pass.
//
// Since ADR-0122 a verdict also carries the failure's **cause**
// (`driver.Cause`) and **when the trouble started**, and a panel leaves
// `healthy` only on the ConfirmAfter-th judged failure in a row: one lost
// packet is not an outage, and at two hundred panels a pass an alert per
// blip is an alert nobody reads. A refusal keeps its immediate gate.
//
// What is deliberately not here: the request budget itself, which is
// `driver.Pace` and is held on every call rather than after one has failed;
// where an alert is delivered, which is the notification domain's; and the
// Postgres-backed writer, which lands with the panel source beside
// `collect.MemoryCursors`.
package panelstate

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"network-service/internal/driver"
)

// State mirrors `network.PanelState`. The two this package decides between are
// ThrottledOrBlocked and Down; the others are here so a record can hold what
// somebody else set without this package flattening it.
type State string

const (
	Healthy     State = "healthy"
	Degraded    State = "degraded"
	Maintenance State = "maintenance"
	Down        State = "down"
	// ThrottledOrBlocked is `rate_limited` and `blocked` together: the panel
	// works and is refusing us. It is the one state that is never retried
	// through.
	ThrottledOrBlocked State = "throttled_or_blocked"
)

// DefaultCooloff is how long a refusing panel is left alone when it did not
// say. It is long enough that a rate limit measured in minutes has expired and
// short enough that a rotated credential is picked up within one service call
// rather than one working day.
const DefaultCooloff = 15 * time.Minute

// ConfirmAfter is how many judged failures in a row move a healthy panel to
// `down` or `degraded` (ADR-0122 point 4) — about three minutes at the bulk
// pass's interval. A refusal is not counted: it is gated at once.
const ConfirmAfter = 3

// Record is a panel's state as the database holds it: `panel.panelState` and
// `panel.blockedSince`, which invariant 11 ties together, and since ADR-0122
// `panelStateCause` and `panelStateSince`. Failures is the tracker's alone.
type Record struct {
	State State
	// BlockedSince is the zero time unless State is ThrottledOrBlocked.
	BlockedSince time.Time
	// Cause is why the panel is not healthy; empty while it is.
	Cause driver.Cause
	// Since is when the panel entered State. Zero when nobody knows.
	Since time.Time
	// Failures is the judged failures in a row, never written: a restart
	// starts it again, which only delays a first alert.
	Failures int
}

// Verdict is what one turn's outcome says. It is a value rather than a write
// so the decision can be read on its own, which is how the table of kinds
// above is asserted without a database.
type Verdict struct {
	Record
	// Alert is true only on the transition **into** a refusal.
	Alert bool
	// Kind is the fault this verdict was read from, empty for a clean pass or
	// an error no driver classified. It is what the owner's alert says.
	Kind driver.FaultKind
	// RetryAfter is the panel's own answer to "when", where it gave one.
	RetryAfter time.Duration
	// Changed is true where the stored record moves: the state or its cause.
	// An unconfirmed failure is not one.
	Changed bool
	// Judged is true where the outcome said something about the panel — it
	// was asked and the turn is evidence. False for a failure on our side of
	// the wire, which is not stamped as a check.
	Judged bool
}

// Judge maps one turn's outcome onto the panel's state.
//
// It is total over every fault kind on purpose: a kind added to `driver` and
// not answered here would fall through to "nothing happened", which is the
// silent reading of a failure this whole row exists to remove.
func Judge(was Record, err error, at time.Time) Verdict {
	if err == nil {
		// Answering is the only evidence that a refusal or an outage is over,
		// and it clears the clock with it: invariant 11 in the other direction.
		next := Record{State: Healthy, Since: was.Since}
		if was.State != Healthy || next.Since.IsZero() {
			next.Since = at
		}
		return Verdict{Record: next, Changed: was.State != Healthy, Judged: true}
	}

	kind, classified := driver.KindOf(err)
	if !classified || !driver.Reached(err) {
		// A publish that failed or a cursor that would not write is not the
		// panel's doing, and marking it down for one would take a healthy
		// panel out of service over our own outage.
		return Verdict{Record: was}
	}

	cause := driver.CauseOf(err)
	verdict := Verdict{Record: was, Kind: kind, Judged: true}
	verdict.Failures = was.Failures + 1
	if fault, ok := err.(*driver.Fault); ok {
		verdict.RetryAfter = fault.RetryAfter
	}

	var target State
	switch kind {
	case driver.FaultRateLimited, driver.FaultBlocked:
		// Gated at once, unconfirmed: retrying through a ban is what makes it
		// permanent (F-027-v).
		verdict.State, verdict.Cause = ThrottledOrBlocked, cause
		if was.State == ThrottledOrBlocked && !was.BlockedSince.IsZero() {
			// Already banned: keep the original clock. Restarting it every
			// pass is a cool-off that can never elapse.
			verdict.Alert = false
		} else {
			verdict.BlockedSince, verdict.Since = at, at
			verdict.Alert = true
		}
		verdict.Changed = was.State != ThrottledOrBlocked || was.Cause != cause
		return verdict
	case driver.FaultUnavailable, driver.FaultTimeout:
		// A timeout once is our deadline and says little; confirmed, it is a
		// panel that does not answer (`unresponsive`, ADR-0122).
		target = Down
	case driver.FaultUnsupported, driver.FaultProtocol:
		// It answered, and the answer was not one we can act on. That is a
		// panel to look at, not one to stop asking.
		target = Degraded
	default:
		target = Down
	}

	if was.State == Healthy && verdict.Failures < ConfirmAfter {
		// Not yet: counted, judged, nothing written.
		return verdict
	}
	verdict.State, verdict.Cause, verdict.BlockedSince = target, cause, time.Time{}
	if was.State == Healthy || was.Since.IsZero() {
		verdict.Since = at
	}
	verdict.Changed = was.State != target || was.Cause != cause
	return verdict
}

// Writer persists a verdict — `PostgresWriter` in a running process. Nil on
// the Tracker keeps the state in memory only, which is what every test wants.
type Writer interface {
	SetState(ctx context.Context, panelID string, rec Record) error
	// Checked stamps a judged turn: `panelCheckedAt`, and `lastHealthyAt`
	// when it was clean. A reader tells a fresh state from a stale one by it.
	Checked(ctx context.Context, panelID string, at time.Time, healthy bool) error
}

// Alerter is how a refusal reaches the person who can end it. Routing it to
// the panel's owner — the tenant for a tenant-owned panel, the platform
// otherwise (invariant 9) — is the notification domain's, not this package's.
type Alerter interface {
	PanelRefused(ctx context.Context, panelID string, v Verdict) error
}

// Tracker holds each panel's state across passes and gates what may be asked.
// The zero value works: no writer, no alerter and DefaultCooloff.
type Tracker struct {
	Writer  Writer
	Alerter Alerter
	// Cooloff is how long a refusing panel is left alone (DefaultCooloff).
	Cooloff time.Duration
	Log     *slog.Logger

	mu      sync.Mutex
	byPanel map[string]entry
}

// entry is one panel's record plus the moment it may be asked again. The gate
// is held here rather than derived from BlockedSince because a panel's own
// Retry-After can be longer than our cool-off, and the database column is a
// clock on the ban rather than a schedule.
type entry struct {
	Record
	notBefore time.Time
}

// Ask says whether this panel may be called at all on this pass. A panel
// nothing is known about is always asked — silence is not a refusal.
func (t *Tracker) Ask(panelID string, at time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	row, known := t.byPanel[panelID]
	if !known || row.State != ThrottledOrBlocked {
		return true
	}
	return !at.Before(row.notBefore)
}

// Restore seeds a panel's state from its row, for a panel this process has
// not observed yet. A ban written before a restart is still a ban after it:
// the cool-off runs from the row's `blockedSince`, not from the moment the
// process came back, because a collector that asks a banned panel on every
// deploy is the retry that makes the ban permanent (F-027-bt).
//
// What this process observed itself always outranks the row, so a restore
// after the first turn changes nothing.
func (t *Tracker) Restore(panelID string, rec Record) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, known := t.byPanel[panelID]; known {
		return
	}
	if t.byPanel == nil {
		t.byPanel = map[string]entry{}
	}
	next := entry{Record: rec}
	if rec.State == ThrottledOrBlocked && !rec.BlockedSince.IsZero() {
		next.notBefore = rec.BlockedSince.Add(t.cooloff())
	}
	t.byPanel[panelID] = next
}

// State is what the tracker currently believes about a panel.
func (t *Tracker) State(panelID string) Record {
	t.mu.Lock()
	defer t.mu.Unlock()
	if row, known := t.byPanel[panelID]; known {
		return row.Record
	}
	return Record{State: Healthy}
}

// Observe records how one panel's turn went.
//
// The write happens before the tracker moves, and a failed write leaves it
// where it was: a ban the loop believes and the database does not have is
// invisible to everything but this process, and the next pass trying again is
// the cheaper of the two wrong answers.
func (t *Tracker) Observe(ctx context.Context, panelID string, err error, at time.Time) error {
	t.mu.Lock()
	was, known := t.byPanel[panelID]
	if !known {
		was = entry{Record: Record{State: Healthy}}
	}
	t.mu.Unlock()

	verdict := Judge(was.Record, err, at)
	if !verdict.Judged {
		return nil
	}

	if t.Writer != nil {
		if verdict.Changed {
			if writeErr := t.Writer.SetState(ctx, panelID, verdict.Record); writeErr != nil {
				return writeErr
			}
		}
		if writeErr := t.Writer.Checked(ctx, panelID, at, err == nil); writeErr != nil {
			// The state is written; a missing stamp ages into "not checked",
			// which is the safe direction on its own.
			t.log().Error("panel check stamp failed", "panel", panelID, "error", writeErr)
		}
	}

	next := entry{Record: verdict.Record}
	if verdict.State == ThrottledOrBlocked {
		next.notBefore = at.Add(t.cooloff())
		if until := at.Add(verdict.RetryAfter); until.After(next.notBefore) {
			// The panel asked for longer than our own cool-off. Its answer is
			// honoured; it is never allowed to shorten ours.
			next.notBefore = until
		}
		if was.State == ThrottledOrBlocked && was.notBefore.After(next.notBefore) {
			next.notBefore = was.notBefore
		}
	}

	t.mu.Lock()
	if t.byPanel == nil {
		t.byPanel = map[string]entry{}
	}
	t.byPanel[panelID] = next
	t.mu.Unlock()

	if verdict.Alert {
		t.log().Warn("panel is refusing us",
			"panel", panelID, "kind", verdict.Kind, "until", next.notBefore)
		if t.Alerter != nil {
			if alertErr := t.Alerter.PanelRefused(ctx, panelID, verdict); alertErr != nil {
				// The state is written and the panel is off the pass. An alert
				// that did not send is a person who was not told, not a reason
				// to keep asking a panel that is refusing us.
				t.log().Error("panel refusal alert failed", "panel", panelID, "error", alertErr)
			}
		}
	}
	return nil
}

func (t *Tracker) cooloff() time.Duration {
	if t.Cooloff > 0 {
		return t.Cooloff
	}
	return DefaultCooloff
}

func (t *Tracker) log() *slog.Logger {
	if t.Log != nil {
		return t.Log
	}
	return slog.Default()
}
