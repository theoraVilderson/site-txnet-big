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
			got := panelstate.Judge(panelstate.Record{State: panelstate.Healthy}, tc.err, at)
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

// Our own deadline implicates the panel in nothing (`contract.md`), so a
// timeout must not move a panel off the state its last real answer earned.
func TestJudgeLeavesTheStateAloneOnOurOwnTimeout(t *testing.T) {
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

// ---- the tracker -----------------------------------------------------------

type writes struct {
	rows []panelstate.Record
	err  error
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
