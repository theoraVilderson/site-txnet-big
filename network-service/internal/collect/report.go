package collect

import (
	"context"
	"time"
)

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

// record writes the rates this pass measured. It runs after the publish and
// the cursor move, and a failure here is logged rather than failing the pass:
// the bytes are billed by then, and failing would re-read and republish them
// to fix a figure the next pass rewrites anyway.
func (l *Loop) record(ctx context.Context, samples []RateSample) {
	if l.Rates == nil || len(samples) == 0 {
		return
	}
	if err := l.Rates.Record(ctx, samples); err != nil {
		l.log().Error("observed rate write failed", "samples", len(samples), "error", err)
	}
}

// stamp records the panels this pass actually read, for the external watchdog
// (F-027-w). Only a turn that published and moved its cursor is in the list:
// the value of `lastSuccessfulCollectionAt` is entirely that it is *not*
// written when nothing was collected, and a stamp on a failed turn is a
// watchdog that reports health it never observed.
//
// A failure here is logged and does not fail the pass, for the same reason the
// rate write does not: the bytes are billed by then, and failing would re-read
// and republish them to fix a clock. An unwritten clock ages into an alert,
// which is the safe direction on its own.
func (l *Loop) stamp(ctx context.Context, marks []PanelProgress) {
	if l.Progress == nil || len(marks) == 0 {
		return
	}
	if err := l.Progress.Collected(ctx, marks); err != nil {
		l.log().Error("collection progress write failed", "panels", len(marks), "error", err)
	}
}
