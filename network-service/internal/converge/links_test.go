package converge_test

import (
	"fmt"
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

// A capture that stored no lines is a fact, but not forever (ADR-0088 rule 5):
// it is asked again once EmptyRecapture has passed, so a panel whose lines
// appear later, or a builder that learns its transport, fills in without a
// new key. Inside the interval it costs nothing.
func TestAPanelWithNoLinksIsCapturedAsNoneAndAskedAgainLater(t *testing.T) {
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
		t.Fatalf("ClientLinks called %d times inside the interval, want 1", n)
	}

	r.at = r.at.Add(converge.EmptyRecapture)
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 2 {
		t.Fatalf("ClientLinks called %d times after EmptyRecapture, want 2", n)
	}
	if again := r.row(t, "c1"); !again.Links.CheckedAt.After(got.Links.CheckedAt) || !again.Links.At.Equal(got.Links.At) {
		t.Errorf("the second capture: checked %v, since %v; want a new check and none served since the first", again.Links.CheckedAt, again.Links.At)
	}
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 2 {
		t.Errorf("ClientLinks called %d times right after the second capture, want 2", n)
	}
}

// An inbound edited on the panel — its port, its SNI, its path — changes the
// lines built from it and neither key of the client, so the key alone kept
// serving the old lines until a regenerate (user, 2026-10-06). The inventory
// read stores the inbound's fingerprint; lines read under another one are
// read again, once.
func TestAnInboundEditedOnThePanelIsCapturedAgain(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	row := wanted("c1")
	row.InboundFingerprint = "fp-1"
	r.desired.Put("panel-1", row)
	r.pass(t)
	r.pass(t)
	if got := r.row(t, "c1"); got.Links.InboundFingerprint != "fp-1" {
		t.Fatalf("links = %+v, want them keyed by the inbound they were read under", got.Links)
	}

	row = r.row(t, "c1")
	row.InboundFingerprint = "fp-2"
	r.desired.Put("panel-1", row)
	report := r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 2 || report.Refreshed != 1 {
		t.Fatalf("ClientLinks called %d times (refreshed %d) after the inbound changed, want 2 (1)", n, report.Refreshed)
	}
	if got := r.row(t, "c1"); got.Links.InboundFingerprint != "fp-2" {
		t.Fatalf("links = %+v, want them read under the edited inbound", got.Links)
	}
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 2 {
		t.Fatalf("ClientLinks called %d times on a steady inbound, want 2", n)
	}
}

// A family that cannot fingerprint its inbounds (Marzban's hosts, Hiddify's
// domains) still changes lines with no key we see: every config's lines are
// read again once LinesRecapture has passed, and not before.
func TestStoredLinesAreReadAgainOnceLinesRecaptureHasPassed(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.desired.Put("panel-1", wanted("c1"))
	r.pass(t)
	r.pass(t)
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 1 {
		t.Fatalf("ClientLinks called %d times inside the day, want 1", n)
	}

	r.at = r.at.Add(converge.LinesRecapture)
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 2 {
		t.Fatalf("ClientLinks called %d times after LinesRecapture, want 2", n)
	}
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 2 {
		t.Fatalf("ClientLinks called %d times right after the refresh, want 2", n)
	}
}

// A refresh spends the panel's budget that the pass's writes also wait on
// (pace.go), so a pass refreshes at most InboundRefreshPerPass for an edited
// inbound and AgedRefreshPerPass for age; the rest wait for the next pass.
// A capture for a new key — a create, a regenerate — is never held back.
func TestRefreshesAreCappedPerPassAndTheRestFollow(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	total := converge.InboundRefreshPerPass + 3
	for i := 0; i < total; i++ {
		row := wanted(fmt.Sprintf("c%02d", i))
		row.InboundFingerprint = "fp-1"
		r.desired.Put("panel-1", row)
	}
	r.pass(t)
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != total {
		t.Fatalf("ClientLinks called %d times for %d creates, want one each: a new key is never capped", n, total)
	}

	for i := 0; i < total; i++ {
		row := r.row(t, fmt.Sprintf("c%02d", i))
		row.InboundFingerprint = "fp-2"
		r.desired.Put("panel-1", row)
	}
	if report := r.pass(t); report.Refreshed != converge.InboundRefreshPerPass {
		t.Fatalf("refreshed %d in one pass, want %d", report.Refreshed, converge.InboundRefreshPerPass)
	}
	if report := r.pass(t); report.Refreshed != 3 {
		t.Fatalf("refreshed %d on the next pass, want the 3 left", report.Refreshed)
	}

	r.at = r.at.Add(converge.LinesRecapture)
	if report := r.pass(t); report.Refreshed != converge.AgedRefreshPerPass {
		t.Fatalf("refreshed %d for age in one pass, want %d", report.Refreshed, converge.AgedRefreshPerPass)
	}
}

// `linksCapturedAt` is since when these lines are served: billing's drain
// waits on it (group-drain.ts, replacementSince), so a refresh that read the
// same lines must not move it, or every daily refresh restarts a drain's
// wait. The refresh's own age is CheckedAt; refreshes are due from it.
func TestARefreshThatReadsTheSameLinesKeepsSinceWhenTheyAreServed(t *testing.T) {
	r := newProvRig(t, fake.Config{})
	r.desired.Put("panel-1", wanted("c1"))
	r.pass(t)
	r.pass(t)
	first := r.row(t, "c1").Links

	r.at = r.at.Add(converge.LinesRecapture)
	r.pass(t)
	got := r.row(t, "c1").Links
	if n := r.panel.CallCount("ClientLinks"); n != 2 {
		t.Fatalf("ClientLinks called %d times after LinesRecapture, want 2", n)
	}
	if !got.At.Equal(first.At) || !got.CheckedAt.After(first.CheckedAt) {
		t.Fatalf("same-lines refresh: served since %v (want %v kept), checked %v (want a new time)", got.At, first.At, got.CheckedAt)
	}
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != 2 {
		t.Fatalf("ClientLinks called %d times right after the refresh, want 2: age runs from CheckedAt", n)
	}

	row := r.row(t, "c1")
	row.Links.Lines = []string{"vless://old-port"}
	row.InboundFingerprint = "fp-2"
	r.desired.Put("panel-1", row)
	r.pass(t)
	if moved := r.row(t, "c1").Links; !moved.At.Equal(r.at) {
		t.Errorf("lines that changed are served since %v, want the refresh's %v", moved.At, r.at)
	}
}

// A family that builds lines from the read the pass already makes (Sanaee and
// alireza0 from the inbound list, Marzban from the user list) hands them over
// in ListClients: they are compared on every pass, written and announced only
// on a change, and cost no request and no share of the refresh cap
// (decision 2026-10-06, contract.links.md rule 6b). An inbound edit reaches
// every config in the next pass.
func TestListedLinesAreComparedEveryPassWithNoRequestAndNoCap(t *testing.T) {
	r := newProvRig(t, fake.Config{LinesInList: true})
	total := converge.InboundRefreshPerPass + 3
	for i := 0; i < total; i++ {
		r.desired.Put("panel-1", wanted(fmt.Sprintf("c%02d", i)))
	}
	r.pass(t)
	r.pass(t)
	asked := r.panel.CallCount("ClientLinks")
	if report := r.pass(t); report.Captured != 0 {
		t.Fatalf("a steady panel captured %d, want 0", report.Captured)
	}

	r.panel.SetLinkHost("edited.invalid:8443")
	report := r.pass(t)
	if report.Captured != total || report.Refreshed != 0 {
		t.Fatalf("after an inbound edit: captured %d, refreshed %d; want %d and 0 (no cap)", report.Captured, report.Refreshed, total)
	}
	for i := 0; i < total; i++ {
		if got := r.row(t, fmt.Sprintf("c%02d", i)).Links.Lines; len(got) != 1 || !strings.Contains(got[0], "edited.invalid") {
			t.Fatalf("c%02d lines = %v, want the edited inbound's", i, got)
		}
	}
	if report := r.pass(t); report.Captured != 0 {
		t.Fatalf("the pass after captured %d, want 0", report.Captured)
	}
	r.at = r.at.Add(converge.LinesRecapture)
	r.pass(t)
	if n := r.panel.CallCount("ClientLinks"); n != asked {
		t.Fatalf("ClientLinks called %d times after the creates, want %d: listed lines are never asked for", n, asked)
	}
}
