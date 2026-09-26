// Package hot is the hot loop: the few configs near their ceiling, read on
// their own interval rather than on the bulk pass's (F-027-u, ADR-0072).
//
// The bulk pass is one minute (`collect.DefaultInterval`), and for most users
// that is far more often than it needs to be. It is not enough for one: a
// 1 Gbit line empties 6 GB of headroom in 53 seconds, so a user can cross a
// ceiling and keep going for most of an interval before anything reads the
// counter that says so. Buying a bigger block is not the answer — that holds
// more of a wallet ahead of consumption, which is ADR-0072's accepted cost and
// its revisit trigger. Reading sooner is.
//
// Three rules shape it:
//
//   - **Membership is time, never bytes.** A config is hot when what is left
//     of its allowance would be gone inside the horizon at the rate it is
//     actually running. 6 GB is 53 seconds at a gigabit and 13 hours at a
//     megabit, and the same figure cannot mean both. Sizing in seconds is why
//     no line speed is "too fast" for this loop.
//   - **The interval tunes itself off the nearest ceiling**, at a quarter of
//     it, so no member spends more than about a quarter of what it has left
//     between two readings. It is clamped to [MinInterval, MaxInterval]: below
//     the floor the loop is a flood on somebody else's server, and above the
//     ceiling it is slower than the bulk pass it exists to beat.
//   - **A hot pass is one request per panel** (invariant 34). `GetUsageFor`
//     takes the named subset, and a family with no subset endpoint serves it
//     from its bulk call — the loop reads the questionnaire's answer, never
//     the shape of the implementation.
//
// What is deliberately not here: money. Sizing the next block from the
// measured rate, buying it and splitting it across a Grant's configs is
// `billing-service`'s `horizon.ts` and the allocator beside it — the hot loop
// on that side of the wire. This package only makes the measurement fresh
// enough for that one to be right, and everything it reads goes out on the
// same delta stream as a bulk pass (`contract.collection.md`).
package hot

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"network-service/internal/collect"
)

const (
	// MinInterval is the fastest the loop may run. A config four seconds from
	// its ceiling would ask for one second; the floor refuses, because a loop
	// that tight is a request rate on a machine we do not own (F-027-v) and
	// the panel's own ceiling is already the enforcement point under it.
	MinInterval = 2 * time.Second
	// MaxInterval is the slowest, and it is the bulk pass's own interval:
	// slower than the bulk pass is not a hot loop, it is a second bulk pass.
	MaxInterval = collect.DefaultInterval
	// IntervalDivisor quarters the nearest time-to-ceiling. A quarter is the
	// bound on how much of what a member has left can run unseen between two
	// readings.
	IntervalDivisor = 4
	// DefaultHorizon is how close to its ceiling a config has to be to be
	// read on this loop rather than the bulk one. It is the same two minutes
	// the block horizon covers (`contract.traffic-block.md`): a config that
	// cannot exhaust its allowance inside one horizon does not need a reading
	// sooner than the bulk pass gives it.
	DefaultHorizon = 120 * time.Second
	// DefaultPanelTimeout bounds one panel's read, as the bulk pass's does:
	// the budget is per panel, and one that stalls must not spend another's.
	DefaultPanelTimeout = 10 * time.Second
	// DefaultConcurrency bounds how many panels are read at once.
	DefaultConcurrency = 8
)

// Candidate is one config the hot loop may watch, with the two figures
// membership is decided on. It carries its whole panel because the normaliser
// needs the declaration — the arithmetic, the line rate and the attribution
// map — and the hot pass runs the same normaliser as the bulk one.
type Candidate struct {
	Panel    collect.Panel
	ConfigID string
	// RemoteID is `config.remoteId`. Empty means the config has never been
	// created at the far end: there is nothing to read, and filling it is
	// provisioning's (F-027-z).
	RemoteID string
	// HeadroomBytes is what is left of this config's allowance —
	// `allocatedCeilingBytes` less the lifetime bytes it has served. Zero or
	// below is a spent allowance, which is hot at any speed.
	HeadroomBytes int64
	// RateBps is the rate the metering side last measured for this config
	// (`config.observedRateBps`), in bits per second. Zero is **never
	// measured**, not idle: a config no pass has produced a delta for has no
	// rate, and it is judged at its panel's line rate instead — the same
	// first-horizon assumption `horizon.ts` buys the first block under.
	RateBps int64
}

// rateBps is the rate this candidate is judged at: what was measured, or the
// panel's declared line rate where nothing has been. Zero is unknown in both
// (`collect.Panel.MaxLineRateBps`), and an unknown rate has no time to ceiling.
func (c Candidate) rateBps() int64 {
	if c.RateBps > 0 {
		return c.RateBps
	}
	return c.Panel.MaxLineRateBps
}

// TimeToCeiling is how long this config's allowance lasts at the rate it is
// running. It is the whole of membership and the whole of the interval, and it
// is the one figure this loop is written around.
//
// A spent allowance is zero however fast the line is. An allowance with
// headroom and no rate to judge it at — never measured, on a panel that
// declares no line rate — returns Never: unknown is not "about to run out",
// and the bulk pass keeps it.
func TimeToCeiling(c Candidate) time.Duration {
	if c.HeadroomBytes <= 0 {
		return 0
	}
	rate := c.rateBps()
	if rate <= 0 {
		return Never
	}
	seconds := float64(c.HeadroomBytes) * 8 / float64(rate)
	if seconds >= Never.Seconds() {
		return Never
	}
	return time.Duration(seconds * float64(time.Second))
}

// Never is the time to ceiling of an allowance that is not measurably being
// spent. It is a duration rather than a second return value so that the
// nearest-ceiling comparison in Interval needs no special case.
const Never = time.Duration(1<<63 - 1)

// IsHot says whether a config belongs to this loop rather than the bulk pass.
func IsHot(c Candidate, horizon time.Duration) bool {
	return TimeToCeiling(c) <= horizon
}

// Interval is the gap before the next hot pass: a quarter of the nearest
// time-to-ceiling in the set, clamped. It is the nearest and not the average,
// because the loop runs for the config closest to its ceiling and the others
// are read early rather than late.
//
// An empty set is MaxInterval. The loop still runs — membership is re-read
// every pass, and a user who starts a download has to be able to join it.
func Interval(members []Candidate) time.Duration {
	nearest := Never
	for _, member := range members {
		if ttc := TimeToCeiling(member); ttc < nearest {
			nearest = ttc
		}
	}
	if nearest == Never {
		return MaxInterval
	}
	next := nearest / IntervalDivisor
	if next < MinInterval {
		return MinInterval
	}
	if next > MaxInterval {
		return MaxInterval
	}
	return next
}

// Source is where the candidates come from — `network.config` joined to its
// counter state, behind an interface so the loop is proved against scripted
// panels the way the collection loop is.
type Source interface {
	Candidates(ctx context.Context) ([]Candidate, error)
}

// CandidatesFunc adapts a function to Source.
type CandidatesFunc func(ctx context.Context) ([]Candidate, error)

func (f CandidatesFunc) Candidates(ctx context.Context) ([]Candidate, error) { return f(ctx) }

// Loop is the hot pass on its self-tuning interval.
type Loop struct {
	Source  Source
	Sink    collect.Sink
	Cursors collect.Cursors
	// Ceilings converges a panel's ceilings at the end of its turn, exactly as
	// it does on the bulk pass (F-027-t). Nil runs the loop as a pure reader.
	Ceilings collect.PassConverger
	// Health gates and records each panel's turn, exactly as the bulk pass's
	// does (F-027-v). A panel refusing us is refusing this loop too, and this
	// is the loop that would otherwise ask it every two seconds.
	Health collect.PanelHealth
	// Rates records what this pass measured. It matters more here than on the
	// bulk pass: these are its own samples over its own interval, and that
	// interval is the only window a hot config's rate means anything over.
	Rates collect.Rates
	// Containment is the bulk pass's panel-wide stop (F-027-ab). A halted
	// panel is halted here too — this loop billing through a halt is the halt
	// not holding — and a hot subset that goes backward together is judged
	// by the same thresholds.
	Containment *collect.Containment
	// Turns is the per-panel lock shared with the bulk pass (F-027-bu). A
	// panel the bulk pass is reading is skipped, never waited on: that read
	// covers the hot clients too. Nil takes no lock.
	Turns *collect.TurnLocks

	// Horizon is how close to its ceiling a config has to be (DefaultHorizon).
	Horizon time.Duration
	// PanelTimeout bounds one panel's read (DefaultPanelTimeout).
	PanelTimeout time.Duration
	// Concurrency bounds panels in flight (DefaultConcurrency).
	Concurrency int
	Clock       func() time.Time
	Log         *slog.Logger
}

// PassReport is what one hot pass did. Considered and Members are both here
// because the difference between them is the whole claim of this loop: a pass
// that looked at 5000 configs and read 3.
type PassReport struct {
	StartedAt  time.Time
	Considered int
	Members    int
	// Panels is how many panels were actually read — one request each.
	Panels int
	Deltas int
	// Busy is how many panels were skipped because the bulk pass held them.
	// It is not a failure: the bulk read covers the hot clients.
	Busy      int
	Failed    []collect.PanelFailure
	NextAfter time.Duration
}

// Run passes on the interval the last pass computed, until the context ends.
// It starts with a pass rather than a wait, and it re-reads membership every
// time: a user who starts a download joins on the next pass, and one who stops
// leaves on it.
func (l *Loop) Run(ctx context.Context) error {
	for {
		next := MaxInterval
		report, err := l.Pass(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			l.log().Error("hot pass failed", "error", err)
		} else {
			next = report.NextAfter
			for _, f := range report.Failed {
				l.log().Warn("hot panel not collected", "panel", f.PanelID, "op", f.Op, "error", f.Err)
			}
		}

		timer := time.NewTimer(next)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

// Pass reads every hot config, one request per panel, and publishes what it
// read on the same stream a bulk pass uses.
//
// It returns an error only where the candidates themselves could not be read.
// A panel that fails is a row in the report with its cursor untouched, because
// one unreachable panel must not stop the others being billed.
func (l *Loop) Pass(ctx context.Context) (PassReport, error) {
	candidates, err := l.Source.Candidates(ctx)
	if err != nil {
		return PassReport{}, err
	}

	report := PassReport{StartedAt: l.now(), Considered: len(candidates)}

	byPanel := map[string][]Candidate{}
	order := []string{}
	var members []Candidate
	for _, candidate := range candidates {
		if candidate.RemoteID == "" || !IsHot(candidate, l.horizon()) {
			continue
		}
		members = append(members, candidate)
		if _, seen := byPanel[candidate.Panel.ID]; !seen {
			order = append(order, candidate.Panel.ID)
		}
		byPanel[candidate.Panel.ID] = append(byPanel[candidate.Panel.ID], candidate)
	}
	report.Members = len(members)
	report.NextAfter = Interval(members)
	if len(members) == 0 {
		// Nobody is near a ceiling, so there is nothing to read. A pass that
		// called every panel to learn that would be the bulk pass again, at a
		// fraction of its interval.
		return report, nil
	}
	report.Panels = len(order)

	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, l.concurrency())
	for _, panelID := range order {
		wg.Add(1)
		go func(rows []Candidate) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()
			if l.Turns != nil {
				release, ok := l.Turns.TryHold(rows[0].Panel.ID)
				if !ok {
					mu.Lock()
					report.Busy++
					mu.Unlock()
					return
				}
				defer release()
			}

			res, op, err := l.collect(ctx, rows)

			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				report.Failed = append(report.Failed, collect.PanelFailure{PanelID: rows[0].Panel.ID, Op: op, Err: err})
				return
			}
			report.Deltas += len(res.Deltas)
		}(byPanel[panelID])
	}
	wg.Wait()
	return report, nil
}

// collect is one panel's hot turn: one subset read, normalise, publish, and
// only then move the cursor. The order is the bulk pass's and the reason is
// the same — a cursor moved before a successful publish is bytes nobody will
// read again (invariant 18) — and the repeat a failure causes is what
// `usage_delta_seen` absorbs (F-027-n).
func (l *Loop) collect(ctx context.Context, rows []Candidate) (collect.Result, string, error) {
	panel := rows[0].Panel
	remoteIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		remoteIDs = append(remoteIDs, row.RemoteID)
	}

	if l.Health != nil && !l.Health.Ask(panel.ID, l.now()) {
		// The same refusal the bulk pass makes, and the one that matters most
		// here: this loop runs every two seconds, so retrying through a ban
		// from it is the fastest way to make the ban permanent (F-027-v).
		return collect.Result{}, collect.OpSkipped, collect.ErrRefusingToAsk
	}
	if halt, err := l.Containment.Halted(ctx, panel.ID); err != nil || halt != "" {
		// Not read, and not converged either: the bulk pass converges a
		// halted panel once a minute, and this loop exists for bytes.
		if err == nil {
			err = collect.ErrCollectionHalted
		}
		return collect.Result{}, collect.OpHalted, err
	}

	panelCtx, cancel := context.WithTimeout(ctx, l.panelTimeout())
	defer cancel()

	readings, err := panel.Driver.GetUsageFor(panelCtx, remoteIDs)
	l.observe(ctx, panel.ID, err)
	if err != nil {
		return collect.Result{}, "GetUsageFor", err
	}

	// MinInterval is the floor on the plausibility cap's window, not the bulk
	// pass's minute: a hot pass two seconds after the last one must be capped
	// over two seconds, or the cap it applies is thirty times too loose.
	res := collect.Normaliser{Panel: panel, Cursors: l.Cursors, MinWindow: MinInterval}.Pass(readings, l.now())
	// Measured before Apply moves the cursors past the window's start.
	rates := collect.ObservedRates(l.Cursors, res)

	if err := l.Containment.Contain(ctx, &res); err != nil {
		return collect.Result{}, "Contain", err
	}
	if err := l.Sink.Publish(ctx, res); err != nil {
		return collect.Result{}, "Publish", err
	}
	if err := l.Cursors.Apply(ctx, res); err != nil {
		return collect.Result{}, "Apply", err
	}
	l.record(ctx, rates)
	if l.Ceilings != nil {
		if err := l.Ceilings.Converge(ctx, panel, res); err != nil {
			// Published and the cursors have moved, so this is not a failed
			// pass: it is a panel whose ceilings are still where they were,
			// and the next pass — which for a hot config is seconds away —
			// tries again.
			l.log().Error("ceiling convergence failed", "panel", panel.ID, "error", err)
		}
	}
	return res, "", nil
}

// observe and record are the bulk pass's, for the same reasons: a panel whose
// state did not persist is read again next time, and a rate that did not write
// is rewritten by the next pass — which for a hot config is seconds away.
func (l *Loop) observe(ctx context.Context, panelID string, err error) {
	if l.Health == nil {
		return
	}
	if obsErr := l.Health.Observe(ctx, panelID, err, l.now()); obsErr != nil {
		l.log().Error("panel state write failed", "panel", panelID, "error", obsErr)
	}
}

func (l *Loop) record(ctx context.Context, samples []collect.RateSample) {
	if l.Rates == nil || len(samples) == 0 {
		return
	}
	if err := l.Rates.Record(ctx, samples); err != nil {
		l.log().Error("observed rate write failed", "samples", len(samples), "error", err)
	}
}

func (l *Loop) horizon() time.Duration {
	if l.Horizon > 0 {
		return l.Horizon
	}
	return DefaultHorizon
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
