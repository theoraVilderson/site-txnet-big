package collect

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// The three figures the row is written around. They are defaults, not limits:
// a deployment may narrow them, and F-027-u's hot loop runs on its own,
// shorter, self-tuning interval over the few configs near their ceiling.
const (
	// DefaultInterval is one bulk pass a minute. It is also the window the
	// plausibility cap floors at, which is why the two are one constant.
	DefaultInterval = 60 * time.Second
	// DefaultPanelTimeout is how long one panel may hold its own turn. The
	// budget is per panel: a panel that stalls must not spend another's.
	DefaultPanelTimeout = 10 * time.Second
	// DefaultConcurrency bounds how many panels are read at once. Unbounded,
	// a pass over 200 panels is 200 simultaneous outbound calls from one
	// process — our own collector as a burst nobody sized for.
	DefaultConcurrency = 8
)

// Source is where the panels to collect from come from. Reading them off
// `network.panel` is the database-backed implementation; the loop takes the
// interface so it can be proved against scripted panels.
type Source interface {
	Panels(ctx context.Context) ([]Panel, error)
}

// PanelsFunc adapts a function to Source.
type PanelsFunc func(ctx context.Context) ([]Panel, error)

func (f PanelsFunc) Panels(ctx context.Context) ([]Panel, error) { return f(ctx) }

// Sink is where a normalised pass goes. F-027-m is the broker publish; the
// loop knows only that a failure means the cursor does not move.
type Sink interface {
	Publish(ctx context.Context, res Result) error
}

// Loop is the bulk collection loop: every panel, once an interval, one request
// each, with a bound on how many are in flight and a deadline on each.
type Loop struct {
	Source  Source
	Sink    Sink
	Cursors Cursors

	// Interval is the gap between passes (DefaultInterval).
	Interval time.Duration
	// PanelTimeout bounds one panel's read (DefaultPanelTimeout).
	PanelTimeout time.Duration
	// Concurrency bounds panels in flight (DefaultConcurrency).
	Concurrency int
	// Clock is the pass's own clock. One reading of it bounds a whole pass,
	// because a bulk read is one request and therefore one moment.
	Clock func() time.Time
	Log   *slog.Logger
}

// PassReport is what one pass did, for the log line and the watchdog. The
// detail is in the published Results; this is the count.
type PassReport struct {
	StartedAt    time.Time
	Panels       int
	Collected    int
	Deltas       int
	Quarantines  int
	Unattributed int
	Failed       []PanelFailure
}

// PanelFailure is one panel that did not complete its pass. Its cursor was not
// moved, so its bytes are read again next time rather than lost.
type PanelFailure struct {
	PanelID string
	Op      string
	Err     error
}

// Run passes on the interval until the context ends. It starts with a pass
// rather than a wait: a collector that has just come up is exactly when the
// gap since the last reading is longest.
func (l *Loop) Run(ctx context.Context) error {
	ticker := time.NewTicker(l.interval())
	defer ticker.Stop()
	for {
		if _, err := l.Pass(ctx); err != nil && ctx.Err() == nil {
			l.log().Error("collection pass failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// Pass runs one bulk pass over every panel the source names. It returns an
// error only when the source itself could not be read: a panel that fails is a
// row in the report, because one unreachable panel must not stop the other
// hundred being billed.
func (l *Loop) Pass(ctx context.Context) (PassReport, error) {
	panels, err := l.Source.Panels(ctx)
	if err != nil {
		return PassReport{}, err
	}

	report := PassReport{StartedAt: l.now(), Panels: len(panels)}
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, l.concurrency())

	for _, panel := range panels {
		wg.Add(1)
		go func(p Panel) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()

			res, op, err := l.collect(ctx, p)

			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				report.Failed = append(report.Failed, PanelFailure{PanelID: p.ID, Op: op, Err: err})
				return
			}
			report.Collected++
			report.Deltas += len(res.Deltas)
			report.Quarantines += len(res.Quarantines)
			report.Unattributed += len(res.Unattributed)
		}(panel)
	}
	wg.Wait()
	return report, nil
}

// collect is one panel's turn: one request, normalise, publish, and only then
// move the cursor. The order is the invariant — a cursor moved before a
// successful publish is bytes nobody will read again (invariant 18).
func (l *Loop) collect(ctx context.Context, p Panel) (Result, string, error) {
	panelCtx, cancel := context.WithTimeout(ctx, l.panelTimeout())
	defer cancel()

	readings, err := p.Driver.GetUsage(panelCtx)
	if err != nil {
		// Nothing is billed from a reading that does not exist, and the
		// cursor is untouched: the next pass reads the same bytes.
		return Result{}, "GetUsage", err
	}

	res := Normaliser{Panel: p, Cursors: l.Cursors, MinWindow: l.interval()}.Pass(readings, l.now())

	if err := l.Sink.Publish(ctx, res); err != nil {
		return Result{}, "Publish", err
	}
	if err := l.Cursors.Apply(ctx, res); err != nil {
		// The pass was published and the cursor did not move, so the next one
		// republishes it. That is the redelivery `usage_delta_seen` absorbs
		// (F-027-n), which is the safe direction.
		return Result{}, "Apply", err
	}
	return res, "", nil
}

func (l *Loop) interval() time.Duration {
	if l.Interval > 0 {
		return l.Interval
	}
	return DefaultInterval
}

func (l *Loop) panelTimeout() time.Duration {
	if l.PanelTimeout > 0 {
		return l.PanelTimeout
	}
	return DefaultPanelTimeout
}

func (l *Loop) concurrency() int {
	if l.Concurrency > 0 {
		return l.Concurrency
	}
	return DefaultConcurrency
}

func (l *Loop) now() time.Time {
	if l.Clock != nil {
		return l.Clock().UTC()
	}
	return time.Now().UTC()
}

func (l *Loop) log() *slog.Logger {
	if l.Log != nil {
		return l.Log
	}
	return slog.Default()
}
