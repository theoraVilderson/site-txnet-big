package collect

import "time"

// PassReport is what one pass did, for the log line and the watchdog. The
// detail is in the published Results; this is the count.
type PassReport struct {
	StartedAt    time.Time
	Panels       int
	Collected    int
	Deltas       int
	Quarantines  int
	Unattributed int
	// Unreviewed is how many panels the source offered that no verdict of
	// acceptance has opened. They are skipped, not failed.
	Unreviewed int
	Failed     []PanelFailure
}

// PanelFailure is one panel that did not complete its pass. Its cursor was not
// moved, so its bytes are read again next time rather than lost.
type PanelFailure struct {
	PanelID string
	Op      string
	Err     error
}

// logReport is the pass's one line, and one line per panel that did not
// complete. A failed turn is otherwise visible only as a clock ageing towards
// the watchdog's alert, which says *that* a panel is not read and never why.
func (l *Loop) logReport(r PassReport) {
	for _, f := range r.Failed {
		l.log().Warn("panel not collected", "panel", f.PanelID, "op", f.Op, "error", f.Err)
	}
	l.log().Info("collection pass",
		"panels", r.Panels, "collected", r.Collected, "failed", len(r.Failed), "unreviewed", r.Unreviewed,
		"deltas", r.Deltas, "quarantines", r.Quarantines, "unattributed", r.Unattributed)
}
