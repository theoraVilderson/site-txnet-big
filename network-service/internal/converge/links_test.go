package converge_test

import (
	"strings"
	"testing"

	"network-service/internal/converge"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// A config's link lines are captured on a read of its client and stored on
// the row; `/sub` renders from them and never asks a panel (ADR-0082 rule 2,
// F-027-bj). A capture is keyed by the client it was read from, so create,
// regenerate, move and every re-key capture again, and a config nobody changed
// costs nothing. A create's lines are read in the pass that created it, from
// the client the panel answered with (F-111-k).

func TestACreatedClientsLinesAreStoredInThePassThatCreatedIt(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.desired.Put("panel-1", wanted("c1"))

	report := r.pass(t) // the create, and its capture
	got := r.row(t, "c1")
	if report.Captured != 1 || len(got.Links.Lines) != 1 || !strings.Contains(got.Links.Lines[0], "uuid-c1") {
		t.Fatalf("after the create's pass: captured %d, links %+v; want the panel's line for uuid-c1", report.Captured, got.Links)
	}
	if got.Links.RemoteID != got.RemoteID || got.Links.UUID != "uuid-c1" || got.Links.At.IsZero() {
		t.Fatalf("capture key = %+v, want the client the create answered with", got.Links)
	}
	if got.State != converge.StatePartial {
		t.Fatalf("state = %q, want partial: the capture reads links, only the list read confirms the client", got.State)
	}

	r.pass(t) // the confirming read finds the lines already read from this client
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 1 {
		t.Fatalf("ClientLinks called %d times, want 1: a created config is not captured again", n)
	}
}

func TestACreatesFailedCaptureIsAFindingAndRetriedOnTheConfirmingRead(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.desired.Put("panel-1", wanted("c1"))
	r.panel.FailLinks(true)

	report := r.pass(t)
	got := r.row(t, "c1")
	if got.RemoteID == "" || !got.Links.At.IsZero() {
		t.Fatalf("row = %+v, want the create recorded and nothing captured", got)
	}
	var unread bool
	for _, f := range report.Findings {
		if f.Action == converge.ActionLinksUnread && f.Err != nil {
			unread = true
		}
	}
	if !unread || report.Failed != 0 || report.Written != 1 {
		t.Fatalf("report = %+v, want the create written, a links_unread finding and no refused write", report)
	}

	r.panel.FailLinks(false)
	r.pass(t)
	if got := r.row(t, "c1"); got.Links.RemoteID != got.RemoteID || len(got.Links.Lines) != 1 {
		t.Fatalf("links = %+v, want the capture retried on the next pass", got.Links)
	}
}

func TestARegeneratedCredentialsLinesReplaceTheOldOnes(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.desired.Put("panel-1", wanted("c1"))
	r.pass(t)
	r.pass(t)

	row := r.row(t, "c1")
	row.UUID, row.State = "uuid-c1-next", converge.StatePending
	r.desired.Put("panel-1", row)
	r.pass(t) // the rotation
	if got := r.row(t, "c1"); !strings.Contains(got.Links.Lines[0], "uuid-c1@") {
		t.Fatalf("lines replaced on the write's pass: %+v; only a read confirms a rotation", got.Links)
	}
	r.pass(t)

	got := r.row(t, "c1")
	if len(got.Links.Lines) != 1 || !strings.Contains(got.Links.Lines[0], "uuid-c1-next") || got.Links.UUID != "uuid-c1-next" {
		t.Fatalf("links after the regenerate = %+v, want the new credential's line", got.Links)
	}
}

func TestARekeyedClientIsCapturedAgain(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.desired.Put("panel-1", wanted("c1"))
	r.pass(t)
	r.pass(t)
	was := r.row(t, "c1").RemoteID

	r.panel.Rename(was, "renamed-by-admin")
	r.pass(t)

	got := r.row(t, "c1")
	if got.Links.RemoteID != "renamed-by-admin" || r.panel.CallCount("ClientLinks") != 2 {
		t.Fatalf("links after the re-key = %+v (%d captures), want them read again from the renamed client",
			got.Links, r.panel.CallCount("ClientLinks"))
	}
}

func TestAFailedCaptureKeepsTheStoredLinesAndIsRetried(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.desired.Put("panel-1", wanted("c1"))
	r.pass(t)
	r.pass(t)
	stored := r.row(t, "c1").Links

	r.panel.Rename(stored.RemoteID, "renamed-by-admin")
	r.panel.FailLinks(true)
	report := r.pass(t)

	got := r.row(t, "c1")
	if got.RemoteID != "renamed-by-admin" {
		t.Fatalf("remoteId = %q, want the re-key recorded whatever the capture did", got.RemoteID)
	}
	if got.Links.RemoteID != stored.RemoteID || len(got.Links.Lines) != 1 {
		t.Fatalf("links = %+v after a failed read, want the stored ones kept: a fault is never an empty answer", got.Links)
	}
	var unread bool
	for _, f := range report.Findings {
		if f.Action == converge.ActionLinksUnread && f.Err != nil {
			unread = true
		}
	}
	if !unread || report.Failed != 0 {
		t.Fatalf("report = %+v, want a links_unread finding and no refused write", report)
	}

	r.panel.FailLinks(false)
	r.pass(t)
	if got := r.row(t, "c1"); got.Links.RemoteID != "renamed-by-admin" {
		t.Fatalf("links = %+v, want the capture retried on the next pass", got.Links)
	}
}

func TestAPanelWithNoLinksIsCapturedAsNoneAndNotAskedAgain(t *testing.T) {
	r := newProvRig(t, fake.Config{Unsupported: map[driver.RowKey]bool{driver.RowNativeSubscriptionLink: true}})
	r.desired.Put("panel-1", wanted("c1"))
	r.pass(t)
	r.pass(t)
	r.pass(t)

	got := r.row(t, "c1")
	if got.Links.At.IsZero() || len(got.Links.Lines) != 0 {
		t.Fatalf("links = %+v, want captured as none: a config that gives no lines is a fact, visibly", got.Links)
	}
	if n := r.panel.CallCount("ClientLinks"); n != 1 {
		t.Fatalf("ClientLinks called %d times, want 1", n)
	}
}
