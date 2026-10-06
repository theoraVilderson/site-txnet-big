package panelstate_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/panelstate"
)

const panelID = "panel-1"

var at = time.Date(2026, 9, 22, 3, 0, 0, 0, time.UTC)

// ---- the judgement ---------------------------------------------------------

// The whole claim of this row: a 429 and a 403 are one state, a 5xx is
// another, and the two are never the same thing. Conflating them either
// quarantines a panel we were rude to or keeps hammering one that is down.
func TestJudgeSeparatesRefusalFromFailure(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		want    state
		blocked bool
	}{
		{"429 is a refusal", driver.FaultForStatus("GetUsage", http.StatusTooManyRequests, nil), state(panelstate.ThrottledOrBlocked), true},
		{"403 is a refusal", driver.FaultForStatus("GetUsage", http.StatusForbidden, nil), state(panelstate.ThrottledOrBlocked), true},
		{"401 is a refusal", driver.FaultForStatus("GetUsage", http.StatusUnauthorized, nil), state(panelstate.ThrottledOrBlocked), true},
		{"5xx is down", driver.FaultForStatus("GetUsage", http.StatusBadGateway, nil), state(panelstate.Down), false},
		{"a dead dial is down", driver.NewFault(driver.FaultUnavailable, "GetUsage", 0, errors.New("dial")), state(panelstate.Down), false},
		{"a protocol answer is degraded", driver.FaultForStatus("GetUsage", http.StatusTeapot, nil), state(panelstate.Degraded), false},
		{"a clean pass is healthy", nil, state(panelstate.Healthy), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// One failure short of confirmed, so the state each kind lands on is visible.
			got := panelstate.Judge(panelstate.Record{State: panelstate.Healthy, Failures: panelstate.ConfirmAfter - 1}, tc.err, at)
			if state(got.State) != tc.want {
				t.Fatalf("state = %q, want %q", got.State, tc.want)
			}
			// Invariant 11: `blockedSince` is set exactly while the state is
			// `throttled_or_blocked` — a ban with no clock on it is a ban
			// nothing can ever decide to leave.
			if tc.blocked != !got.BlockedSince.IsZero() {
				t.Fatalf("blockedSince = %v for state %q", got.BlockedSince, got.State)
			}
		})
	}
}

type state string

// A panel already down that now runs past our deadline is still down; the
// owner is not alerted again for it.
func TestJudgeKeepsADownPanelDownOnATimeout(t *testing.T) {
	was := panelstate.Record{State: panelstate.Down}
	got := panelstate.Judge(was, driver.NewFault(driver.FaultTimeout, "GetUsage", 0, context.DeadlineExceeded), at)
	if got.State != panelstate.Down {
		t.Fatalf("state = %q, want it left at %q", got.State, panelstate.Down)
	}
	if got.Alert {
		t.Fatal("our own deadline alerted the panel's owner")
	}
}

// A failure no driver classified is not the panel's: a publish or a cursor
// write that failed says nothing about the far end.
func TestJudgeIgnoresAnErrorNoDriverClassified(t *testing.T) {
	was := panelstate.Record{State: panelstate.Healthy}
	got := panelstate.Judge(was, errors.New("broker refused the publish"), at)
	if got.State != panelstate.Healthy || got.Alert {
		t.Fatalf("an unclassified error moved the panel to %q (alert=%v)", got.State, got.Alert)
	}
}

// The clock is set once, when the refusal starts, and not restarted by every
// pass that finds it still refusing — otherwise the cool-off never elapses and
// the ban is permanent by arithmetic.
func TestJudgeKeepsTheOriginalBlockedSince(t *testing.T) {
	first := panelstate.Judge(panelstate.Record{State: panelstate.Healthy},
		driver.FaultForStatus("GetUsage", http.StatusTooManyRequests, nil), at)
	second := panelstate.Judge(panelstate.Record{State: first.State, BlockedSince: first.BlockedSince},
		driver.FaultForStatus("GetUsage", http.StatusTooManyRequests, nil), at.Add(time.Minute))

	if !second.BlockedSince.Equal(first.BlockedSince) {
		t.Fatalf("blockedSince moved from %v to %v", first.BlockedSince, second.BlockedSince)
	}
	if !first.Alert {
		t.Fatal("the refusal that started the ban did not alert the owner")
	}
	if second.Alert {
		t.Fatal("the owner was alerted again on a pass that changed nothing")
	}
}

// A panel that answers again is out of the ban, and its clock is cleared with
// it — invariant 11 holds in both directions.
func TestJudgeClearsTheBanOnASuccessfulPass(t *testing.T) {
	got := panelstate.Judge(panelstate.Record{State: panelstate.ThrottledOrBlocked, BlockedSince: at}, nil, at.Add(time.Hour))
	if got.State != panelstate.Healthy || !got.BlockedSince.IsZero() {
		t.Fatalf("state = %q, blockedSince = %v", got.State, got.BlockedSince)
	}
}

// ADR-0122 point 4: one lost packet is not an outage. A panel leaves
// `healthy` only on the ConfirmAfter-th judged failure in a row, and the
// first clean turn brings it back.
func TestJudgeConfirmsAFailureBeforeCallingThePanelDown(t *testing.T) {
	fault := driver.FaultForStatus("GetUsage", http.StatusBadGateway, nil)
	rec := panelstate.Record{State: panelstate.Healthy}
	for i := 1; i < panelstate.ConfirmAfter; i++ {
		v := panelstate.Judge(rec, fault, at.Add(time.Duration(i)*time.Minute))
		if v.State != panelstate.Healthy || v.Changed {
			t.Fatalf("failure %d moved the panel to %q (changed=%v)", i, v.State, v.Changed)
		}
		if !v.Judged {
			t.Fatalf("failure %d was not judged: the panel was asked and answered", i)
		}
		rec = v.Record
	}
	third := at.Add(time.Duration(panelstate.ConfirmAfter) * time.Minute)
	v := panelstate.Judge(rec, fault, third)
	if v.State != panelstate.Down || !v.Changed {
		t.Fatalf("the confirming failure left the panel %q (changed=%v)", v.State, v.Changed)
	}
	if v.Cause != driver.CauseServerError || !v.Since.Equal(third) {
		t.Fatalf("cause %q since %v, want %q since %v", v.Cause, v.Since, driver.CauseServerError, third)
	}

	back := panelstate.Judge(v.Record, nil, third.Add(time.Minute))
	if back.State != panelstate.Healthy || !back.Changed || back.Cause != "" || back.Failures != 0 {
		t.Fatalf("a clean turn left %+v", back.Record)
	}
	if !back.Since.Equal(third.Add(time.Minute)) {
		t.Fatalf("recovered since %v", back.Since)
	}
}

// A panel that keeps running past our deadline is not one answering slowly
// once: confirmed, it is down as `unresponsive` (ADR-0122), where a single
// timeout still says nothing.
func TestJudgeConfirmedTimeoutsAreUnresponsive(t *testing.T) {
	timeout := driver.NewFault(driver.FaultTimeout, "GetUsage", 0, context.DeadlineExceeded)
	rec := panelstate.Record{State: panelstate.Healthy}
	for i := 0; i < panelstate.ConfirmAfter; i++ {
		rec = panelstate.Judge(rec, timeout, at).Record
	}
	if rec.State != panelstate.Down || rec.Cause != driver.CauseUnresponsive {
		t.Fatalf("got %q / %q", rec.State, rec.Cause)
	}
}

// Since is when the trouble started, not when it was last seen: a panel down
// for three days says three days. A change of cause is written; the clock is not restarted.
func TestJudgeKeepsSinceWhileThePanelStaysDown(t *testing.T) {
	was := panelstate.Record{State: panelstate.Down, Cause: driver.CauseServerError, Since: at}
	same := panelstate.Judge(was, driver.FaultForStatus("GetUsage", http.StatusBadGateway, nil), at.Add(time.Hour))
	if same.Changed || !same.Since.Equal(at) {
		t.Fatalf("an unchanged outage was rewritten (changed=%v, since=%v)", same.Changed, same.Since)
	}
	moved := panelstate.Judge(was, driver.FaultForStatus("GetUsage", http.StatusNotFound, nil), at.Add(time.Hour))
	if !moved.Changed || moved.Cause != driver.CauseNotFound || !moved.Since.Equal(at) {
		t.Fatalf("a new cause: changed=%v cause=%q since=%v", moved.Changed, moved.Cause, moved.Since)
	}
}

// ---- the tracker -----------------------------------------------------------

// Every turn the panel was actually judged on is stamped, so a reader can tell
// a fresh `healthy` from a stale one; a failure that was ours is not.
func TestTrackerStampsEveryJudgedTurn(t *testing.T) {
	w := &writes{}
	tracker := &panelstate.Tracker{Writer: w}
	observe(t, tracker, nil, at)
	observe(t, tracker, driver.FaultForStatus("GetUsage", http.StatusBadGateway, nil), at.Add(time.Minute))
	observe(t, tracker, errors.New("broker refused the publish"), at.Add(2*time.Minute))
	if len(w.checked) != 2 || !w.checked[0] || w.checked[1] {
		t.Fatalf("checked stamps = %v, want [true false]", w.checked)
	}
	if len(w.rows) != 0 {
		t.Fatalf("an unconfirmed failure wrote a state: %+v", w.rows)
	}
}

// The count lives in the tracker across passes, so three failing passes —
// not three failures inside one judge call — make a panel down.
func TestTrackerConfirmsAcrossPasses(t *testing.T) {
	w := &writes{}
	tracker := &panelstate.Tracker{Writer: w}
	fault := driver.FaultForStatus("GetUsage", http.StatusBadGateway, nil)
	for i := 0; i < panelstate.ConfirmAfter; i++ {
		observe(t, tracker, fault, at.Add(time.Duration(i)*time.Minute))
	}
	if got := tracker.State(panelID); got.State != panelstate.Down {
		t.Fatalf("after %d failing passes the panel is %q", panelstate.ConfirmAfter, got.State)
	}
	if len(w.rows) != 1 || w.rows[0].State != panelstate.Down || w.rows[0].Cause != driver.CauseServerError {
		t.Fatalf("state writes = %+v", w.rows)
	}
}

type writes struct {
	rows    []panelstate.Record
	checked []bool
	err     error
}

func (w *writes) Checked(_ context.Context, _ string, _ time.Time, healthy bool) error {
	w.checked = append(w.checked, healthy)
	return nil
}

func (w *writes) SetState(_ context.Context, _ string, rec panelstate.Record) error {
	if w.err != nil {
		return w.err
	}
	w.rows = append(w.rows, rec)
	return nil
}

type alerts struct{ sent []panelstate.Verdict }

func (a *alerts) PanelRefused(_ context.Context, _ string, v panelstate.Verdict) error {
	a.sent = append(a.sent, v)
	return nil
}

// The row's own words: no retry. A panel refusing us is not asked again inside
// its cool-off, because retrying through a ban is what makes it permanent.
func TestTrackerRefusesToAskABlockedPanelAgain(t *testing.T) {
	w, a := &writes{}, &alerts{}
	tracker := &panelstate.Tracker{Writer: w, Alerter: a, Cooloff: 10 * time.Minute}

	if !tracker.Ask(panelID, at) {
		t.Fatal("a panel nothing is known about was not asked")
	}
	observe(t, tracker, driver.FaultForStatus("GetUsage", http.StatusForbidden, nil), at)

	if tracker.Ask(panelID, at.Add(time.Minute)) {
		t.Fatal("a blocked panel was asked again inside its cool-off")
	}
	if !tracker.Ask(panelID, at.Add(11*time.Minute)) {
		t.Fatal("a blocked panel was never asked again — the ban is permanent")
	}
}

// `down` is the other half of the distinction, and it is what makes it worth
// having: a panel that is failing is read again on the very next pass.
func TestTrackerAsksADownPanelOnTheNextPass(t *testing.T) {
	tracker := &panelstate.Tracker{Cooloff: 10 * time.Minute}
	observe(t, tracker, driver.FaultForStatus("GetUsage", http.StatusBadGateway, nil), at)

	if !tracker.Ask(panelID, at.Add(time.Second)) {
		t.Fatal("a down panel was held off like a blocked one")
	}
}

// The panel's own answer to "when" is honoured where it gave one, and never
// shortens our cool-off: a panel asking for an hour gets an hour.
func TestTrackerHonoursRetryAfterBeyondTheCooloff(t *testing.T) {
	tracker := &panelstate.Tracker{Cooloff: time.Minute}
	fault := driver.FaultForStatus("GetUsage", http.StatusTooManyRequests, nil)
	fault.RetryAfter = 30 * time.Minute
	observe(t, tracker, fault, at)

	if tracker.Ask(panelID, at.Add(5*time.Minute)) {
		t.Fatal("the panel asked for 30 minutes and was asked again after 5")
	}
	if !tracker.Ask(panelID, at.Add(31*time.Minute)) {
		t.Fatal("the panel's own Retry-After never elapsed")
	}
}

// One alert per ban, and it reaches the owner rather than a log line nobody
// reads. A pass a minute would otherwise be an alert a minute.
func TestTrackerAlertsTheOwnerOnceAndWritesTheState(t *testing.T) {
	w, a := &writes{}, &alerts{}
	tracker := &panelstate.Tracker{Writer: w, Alerter: a, Cooloff: time.Second}

	fault := driver.FaultForStatus("GetUsage", http.StatusTooManyRequests, nil)
	observe(t, tracker, fault, at)
	observe(t, tracker, fault, at.Add(2*time.Second))

	if len(a.sent) != 1 {
		t.Fatalf("owner alerted %d times for one ban", len(a.sent))
	}
	if a.sent[0].Kind != driver.FaultRateLimited {
		t.Fatalf("alert carried kind %q", a.sent[0].Kind)
	}
	for _, row := range w.rows {
		if row.State != panelstate.ThrottledOrBlocked {
			t.Fatalf("wrote state %q", row.State)
		}
	}
}

// A state the loop believes and the database does not have is the drift that
// makes a ban invisible, so a failed write leaves the tracker where it was and
// the next pass tries again rather than holding an unwritten ban.
func TestTrackerKeepsTheOldStateWhenTheWriteFails(t *testing.T) {
	w := &writes{err: errors.New("no connection")}
	tracker := &panelstate.Tracker{Writer: w, Cooloff: time.Minute}

	if err := tracker.Observe(context.Background(), panelID,
		driver.FaultForStatus("GetUsage", http.StatusForbidden, nil), at); err == nil {
		t.Fatal("a failed state write was reported as success")
	}
	if !tracker.Ask(panelID, at.Add(time.Second)) {
		t.Fatal("the tracker held a ban it could not write down")
	}
}

func observe(t *testing.T, tracker *panelstate.Tracker, err error, when time.Time) {
	t.Helper()
	if obsErr := tracker.Observe(context.Background(), panelID, err, when); obsErr != nil {
		t.Fatalf("Observe: %v", obsErr)
	}
}

// A call our own breaker stopped never reached the panel: it is not evidence.
// Judged, it alternated with the real dial's cause every pass on dev
// (2026-10-06) — connection_refused, unreachable, connection_refused — and
// each flip was a "new cause" told to the owner, once a minute.
func TestJudgeIgnoresACallOurBreakerStopped(t *testing.T) {
	was := panelstate.Record{State: panelstate.Down, Cause: driver.CauseConnectionRefused, Since: at}
	open := driver.NewFault(driver.FaultUnavailable, "GetUsage", 0, driver.ErrCircuitOpen)
	got := panelstate.Judge(was, open, at.Add(time.Minute))
	if got.Changed || got.Judged || got.Cause != driver.CauseConnectionRefused {
		t.Fatalf("a breaker-stopped call was judged: %+v (changed=%v judged=%v)", got.Record, got.Changed, got.Judged)
	}
}
