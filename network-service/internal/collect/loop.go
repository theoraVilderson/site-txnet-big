package collect

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"network-service/internal/driver"
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

// PassConverger carries a panel's ceilings on the same pass that read its
// counters — `converge.Ceilings` (F-027-t). It is an interface here, and the
// loop calls it after the cursors have moved, because the reset it has to act
// on is the one this pass just detected: a ceiling left over a counter
// somebody zeroed is free traffic until the next interval, and ADR-0072 has no
// room for an interval of it.
type PassConverger interface {
	Converge(ctx context.Context, p Panel, res Result) error
}

// Planner is the lease planner (ADR-0093), `leaseplan.Planner`: the only
// writer of a config's ceiling since F-027-db. It is handed the raw readings
// of a turn that completed, writes the ceilings to the rows, and has no way
// to the panel: the convergence step right after it carries them. Observe
// says whether its plan left the panel anything to carry — a write, a lease,
// a close, or a write still waiting to be read back — which is what lets a
// planned poll skip the convergence step (F-027-ds). Allocate is
// the woken turn's: no readings, only configs with no ceiling yet. Failed is
// told of a read that failed, which starts an outage the next read ends: a
// panel's outage history scales its MaxLease (F-027-dh).
type Planner interface {
	Observe(ctx context.Context, p Panel, readings []driver.ClientUsage, at time.Time) (bool, error)
	Allocate(ctx context.Context, p Panel, at time.Time) error
	Failed(panelID string, at time.Time)
}

// SessionTotals is what a push panel's clients have been served, as the
// receiver accounted it (`radius_session`, `PostgresCursors.Totals`): one
// reading per claimed client, its sessions' high-water marks summed less the
// Σ its client was created at. It is the figure the panel's own per-user
// limit is checked against, and the bytes are already billed, so the turn
// plans on it and publishes nothing.
//
// router is the panel's own totals where this turn read them
// (driver.TotalsReader), nil where it did not. A client whose total went
// down since the last read was made again on the router, and its baseline
// moves to what our Σ held beyond the router's figure (F-027-du).
type SessionTotals interface {
	Totals(ctx context.Context, panelID string, router []driver.ClientUsage) ([]driver.ClientUsage, error)
}

// PanelHealth is told how each panel's turn went and says whether a panel may
// be asked at all — `panelstate.Tracker` (F-027-v). It is an interface here so
// the loop keeps no opinion about a `429`: the distinction between a panel
// that is refusing us and one that is down belongs in one place, and this loop
// is not it.
type PanelHealth interface {
	Ask(panelID string, at time.Time) bool
	Observe(ctx context.Context, panelID string, err error, at time.Time) error
}

// PanelProgress is one panel's turn having completed — the moment
// `panel.lastSuccessfulCollectionAt` records (F-027-w).
//
// It is the watchdog's whole input, and it is written from **inside** the
// pass rather than derived from a log line, because the question the watchdog
// asks is not "is the process alive" but "is this panel still being read".
// Those differ exactly when it matters: a collector up, healthy on `/health`,
// and stalled on one panel's credential.
type PanelProgress struct {
	PanelID string
	// At is the pass's clock, which is the moment the counters describe.
	At time.Time
}

// Progress is where those marks are written — `PostgresProgress` in a running
// process. Nil on a loop records nothing, which is what every test of the
// normaliser wants.
type Progress interface {
	Collected(ctx context.Context, marks []PanelProgress) error
}

// OpSkipped is the `Op` of a panel that was not called at all, so a panel held
// off by a ban is a row in the report rather than a silent absence.
const OpSkipped = "skipped"

// ErrRefusingToAsk is why. It is not a `driver.Fault`: nothing was asked, so
// nothing about the far end was learned, and `Observe` leaves the state alone.
var ErrRefusingToAsk = errors.New("panel is refusing us; not asked again until its cool-off has run")

// Loop is the bulk collection loop: every panel, once an interval, one request
// each, with a bound on how many are in flight and a deadline on each.
type Loop struct {
	Source  Source
	Sink    Sink
	Cursors Cursors
	// Ceilings converges this panel's ceilings at the end of its turn. Nil
	// runs the loop as a pure reader, which is what every test of the
	// normaliser wants.
	Ceilings PassConverger
	// Health gates and records each panel's turn (F-027-v). Nil asks every
	// panel and records nothing, which is what every test of the normaliser
	// wants.
	Health PanelHealth
	// Rates records the rate each delta was measured at —
	// `config.observedRateBps`, which is what the hot loop judges membership
	// on. Nil records nothing.
	Rates Rates
	// Progress stamps `panel.lastSuccessfulCollectionAt` for each panel whose
	// turn completed — the external watchdog's input (F-027-w). Nil records
	// nothing.
	Progress Progress
	// Containment is the panel-wide stop (F-027-ab): a pass that looks like a
	// backup restore is parked before it publishes, and the panel is not read
	// again until the event is acknowledged. Nil contains nothing.
	Containment *Containment
	// Turns is the per-panel lock this loop shares with the hot loop
	// (F-027-bu). Nil takes no lock, which is right only while no other loop
	// reads the same panels.
	Turns *TurnLocks
	// Planner plans each completed turn and writes its ceilings (F-027-db).
	// Nil plans nothing.
	Planner Planner
	// Sessions is a push panel's reading (F-027-du): what the RADIUS
	// receiver has accounted per client. A loop without it fails a push
	// panel's turn rather than planning it on nothing.
	Sessions SessionTotals

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

// Run passes on the interval until the context ends. It starts with a pass
// rather than a wait: a collector that has just come up is exactly when the
// gap since the last reading is longest.
func (l *Loop) Run(ctx context.Context) error {
	ticker := time.NewTicker(l.interval())
	defer ticker.Stop()
	for {
		report, err := l.Pass(ctx)
		switch {
		case err != nil && ctx.Err() == nil:
			l.log().Error("collection pass failed", "error", err)
		case err == nil:
			l.logReport(report)
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
	// Fail closed on the verdict (F-027-aq). The source is expected to offer
	// only accepted panels, and this is what holds if it does not: a refused
	// panel converged is a panel provisioned, which is exactly what refusing
	// it at registration was for.
	reviewed := panels[:0:0]
	for _, p := range panels {
		if !p.ReviewState.Collectable() {
			report.Unreviewed++
			continue
		}
		reviewed = append(reviewed, p)
	}
	panels = reviewed
	// The panels whose turn completed, stamped together once the pass is over:
	// one write for a pass over two hundred panels, not two hundred.
	marks := make([]PanelProgress, 0, len(panels))
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
			if l.Turns != nil {
				defer l.Turns.Hold(p.ID)()
			}

			res, op, err := l.collect(ctx, p, l.interval(), false)

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
			marks = append(marks, PanelProgress{PanelID: p.ID, At: res.ObservedAt})
		}(panel)
	}
	wg.Wait()
	l.stamp(ctx, marks)
	return report, nil
}

// collect is one panel's turn: one request, normalise, publish, and only then
// move the cursor. The order is the invariant — a cursor moved before a
// successful publish is bytes nobody will read again (invariant 18).
// minWindow floors the plausibility cap's window: the bulk interval on a bulk
// pass, PollMinWindow on a planned poll (F-027-de). A polled turn converges
// only what its plan owes (F-027-ds); the bulk pass converges every turn.
func (l *Loop) collect(ctx context.Context, p Panel, minWindow time.Duration, polled bool) (Result, string, error) {
	if l.Health != nil && !l.Health.Ask(p.ID, l.now()) {
		// A panel that answered `429` or `403` is not asked again inside its
		// cool-off: retrying through a ban is what makes the ban permanent
		// (F-027-v). A panel that is merely down is asked on every pass.
		return Result{}, OpSkipped, ErrRefusingToAsk
	}

	halt, err := l.Containment.Halted(ctx, p.ID)
	if err != nil {
		return Result{}, OpHalted, err
	}
	if halt != "" {
		// Not read, because what it reports is what nobody believes yet — but
		// still converged, because a suspension or a delete has to reach the
		// panel whatever its counters say, and the ceilings hold over the
		// cursors the event pass left (F-027-ab). Unless the server is not
		// ours at all (F-027-cf): then converging recreates our configs on it.
		if halt.Converges() {
			l.converge(ctx, p, Result{PanelID: p.ID, OwnershipType: p.OwnershipType, TenantID: p.TenantID, ObservedAt: l.now()})
		}
		return Result{}, OpHalted, ErrCollectionHalted
	}

	panelCtx, cancel := context.WithTimeout(ctx, l.panelTimeout())
	defer cancel()

	if p.Transport == driver.TransportPush {
		return l.pushTurn(ctx, panelCtx, p, polled)
	}

	readings, err := p.Driver.GetUsage(panelCtx)
	l.observe(ctx, p.ID, err)
	if err != nil && l.Planner != nil && ctx.Err() == nil {
		// Our own shutdown is not the panel's outage.
		l.Planner.Failed(p.ID, l.now())
	}
	if err != nil {
		// Nothing is billed from a reading that does not exist, and the
		// cursor is untouched: the next pass reads the same bytes.
		return Result{}, "GetUsage", err
	}

	res := Normaliser{Panel: p, Cursors: l.Cursors, MinWindow: minWindow}.Pass(readings, l.now())
	// Measured before the cursors move: the window a rate means anything over
	// starts at the previous reading, and after Apply that figure is gone.
	rates := ObservedRates(l.Cursors, res)

	if err := l.Containment.Contain(ctx, &res); err != nil {
		// The event could not be written, so nothing is published and the
		// cursors stay: the next pass judges the same restore again.
		return Result{}, "Contain", err
	}
	if err := l.Sink.Publish(ctx, res); err != nil {
		return Result{}, "Publish", err
	}
	if err := l.Cursors.Apply(ctx, res); err != nil {
		// The pass was published and the cursor did not move, so the next one
		// republishes it. That is the redelivery `usage_delta_seen` absorbs
		// (F-027-n), which is the safe direction.
		return Result{}, "Apply", err
	}
	l.record(ctx, rates)
	owed := l.plan(ctx, p, readings, res.ObservedAt)
	if !polled || owed || sawReset(res) {
		l.converge(ctx, p, res)
	}
	return res, "", nil
}

// pushTurn is a push panel's turn (F-027-du). Its bytes came as packets and
// the receiver billed them, so nothing is published or moved: the reading is
// the receiver's totals. The router is asked for its own per-client totals
// where its family keeps them — they show a user made again by hand, and the
// read proves the REST API that carries the ceiling answers — or else only
// whether that API answers. A panel that does not is an outage, as a failed
// read is on a pull panel. Then the turn plans and converges exactly as a
// pull turn does.
func (l *Loop) pushTurn(ctx, panelCtx context.Context, p Panel, polled bool) (Result, string, error) {
	var router []driver.ClientUsage
	op := "HealthCheck"
	var err error
	if r, ok := driver.TotalsOf(p.Driver); ok {
		op = "ClientTotals"
		router, err = r.ClientTotals(panelCtx)
	} else {
		err = p.Driver.HealthCheck(panelCtx)
	}
	l.observe(ctx, p.ID, err)
	if err != nil {
		if l.Planner != nil && ctx.Err() == nil {
			l.Planner.Failed(p.ID, l.now())
		}
		return Result{}, op, err
	}
	if l.Sessions == nil {
		return Result{}, "Sessions", errors.New("no session totals to plan a push panel on")
	}
	readings, err := l.Sessions.Totals(panelCtx, p.ID, router)
	if err != nil {
		return Result{}, "Sessions", err
	}
	res := Result{PanelID: p.ID, OwnershipType: p.OwnershipType, TenantID: p.TenantID, ObservedAt: l.now()}
	if owed := l.plan(ctx, p, readings, res.ObservedAt); !polled || owed {
		l.converge(ctx, p, res)
	}
	return res, "", nil
}

// converge carries the panel's desired state at the end of its turn. The
// bytes are published and the cursors have moved by then, so a failure is not
// a failed pass: it is a panel whose ceilings are still where they were.
// Failing the pass here would re-read and republish bytes that were already
// billed, to fix a number that the next pass will try again anyway.
func (l *Loop) converge(ctx context.Context, p Panel, res Result) {
	if l.Ceilings == nil {
		return
	}
	if err := l.Ceilings.Converge(ctx, p, res); err != nil {
		l.log().Error("ceiling convergence failed", "panel", p.ID, "error", err)
	}
}

// plan runs the planner over the turn, after the bytes are billed and the
// cursors moved, and before the convergence step, so what it writes reaches
// the panel in the same turn. A failure is logged: the bytes are billed, and
// the ceilings stay where the last plan left them. It says whether the panel
// is owed a convergence: no planner, or a plan that failed, owes one, since
// nothing then says the panel already holds what the rows do.
func (l *Loop) plan(ctx context.Context, p Panel, readings []driver.ClientUsage, at time.Time) bool {
	if l.Planner == nil {
		return true
	}
	owed, err := l.Planner.Observe(ctx, p, readings, at)
	if err != nil {
		l.log().Error("lease plan failed", "panel", p.ID, "error", err)
		return true
	}
	return owed
}

// sawReset: a counter on this turn went backward. The ceiling the panel holds
// is then in the counter's old origin, and it is restated on this turn
// whatever the plan did (ADR-0072, `converge.Ceilings`).
func sawReset(res Result) bool {
	for _, a := range res.Advances {
		if !a.Counter.LastResetAt.IsZero() && a.Counter.LastResetAt.Equal(res.ObservedAt) {
			return true
		}
	}
	return false
}

// observe hands one panel's outcome to the health tracker. A tracker that
// cannot write is logged and not failed: the pass is about bytes, and a panel
// whose state did not persist is read again next time.
func (l *Loop) observe(ctx context.Context, panelID string, err error) {
	if l.Health == nil {
		return
	}
	if obsErr := l.Health.Observe(ctx, panelID, err, l.now()); obsErr != nil {
		l.log().Error("panel state write failed", "panel", panelID, "error", obsErr)
	}
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
