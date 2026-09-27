package collect

import (
	"context"
	"sync"
	"time"

	"network-service/internal/driver"
)

const (
	// DefaultPollResolution is how often the poller looks for a due panel. A
	// poll is planned one second after the panel's tick (`leaseplan.PollGuard`)
	// and the next tick is J away, so a quarter second late still reads it.
	DefaultPollResolution = 250 * time.Millisecond
	// PollMinWindow floors the plausibility cap's window on a planned poll,
	// as the hot loop's did: a read five seconds after the last is capped
	// over five seconds, not over the bulk pass's minute.
	PollMinWindow = 2 * time.Second
	// PollRetry is how long a panel whose planned poll failed waits before
	// the next (SPEC §4). The failed poll's hint is still due, and without it
	// a down panel would be asked every sweep.
	PollRetry = 15 * time.Second
)

// Schedule says when a panel should next be read — `leaseplan.Planner`,
// from its `PollBy` hints aligned to the panel's tick (SPEC §6-6). minPoll
// is the panel's own floor (PollGap). False: nothing asked for a read, and
// the bulk pass is the panel's only one.
type Schedule interface {
	NextPoll(panelID string, minPoll time.Duration) (time.Time, bool)
}

// PollRequests is what one planned poll asks a panel for at most: the usage
// read and the convergence step's `ListClients`, which a poll whose plan owed
// nothing skips (F-027-ds). A paged read costs more, and `Paced` holds that to
// the budget regardless.
const PollRequests = 2

// PollGap is the least time between two planned polls of one panel: polls
// spend at most half of `panel.maxRequestsPerMinute`, leaving the other half
// to the ceiling writes and the bulk pass. `Paced` still holds every request
// to the whole budget; this keeps polls from being what fills it.
func PollGap(p Panel) time.Duration {
	if p.MaxRequestsPerMinute <= 0 {
		return 0
	}
	return 2 * PollRequests * time.Minute / time.Duration(p.MaxRequestsPerMinute)
}

// WriteRate is the writes a second the planner may plan on (`quota.PanelState`
// .WriteRate, F-027-df): the half of the rate the Pacer allows now that polls
// leave (PollGap), per second. It stretches the lease horizon on a slow or
// refusing panel, so fewer writes are asked of it. Zero for an unpaced
// driver, which the planner reads as no stretch.
func WriteRate(p Panel) float64 {
	pc, ok := driver.PacerOf(p.Driver)
	if !ok {
		return 0
	}
	return pc.Rate() / 2 / pc.Budget().Window.Seconds()
}

// Poller reads each panel when the lease planner asks for it (F-027-de),
// replacing the hot loop's one interval for every panel. A planned poll is
// the bulk pass's own turn — one whole-panel read, publish, plan, converge —
// so the planner sees every counter on the panel, and its tick clock learns
// from reads less than a tick apart, which a minute's pass never is. Its
// converge runs only when the plan owes the panel something or a counter
// reset (F-027-ds): a poll can come every 5 s near a Grant's end, and the
// step is a whole-panel `ListClients` plus the writes it repeats.
//
// The bulk pass stays the safety net: a panel no plan hinted, a poll that
// found the panel busy, and a process that just started are all read by it.
type Poller struct {
	Loop *Loop
	// Panels is what the bulk pass last offered (`PostgresSource.Offered`),
	// as for the waker: a panel is opened only by the pass.
	Panels   func() []Panel
	Schedule Schedule
	// Resolution is how often Run sweeps (DefaultPollResolution).
	Resolution time.Duration

	mu      sync.Mutex
	running map[string]bool
	retry   map[string]time.Time // panel -> not before, after a failed poll
	wg      sync.WaitGroup
}

// Run sweeps until the context ends.
func (p *Poller) Run(ctx context.Context) {
	res := p.Resolution
	if res <= 0 {
		res = DefaultPollResolution
	}
	ticker := time.NewTicker(res)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			p.Wait()
			return
		case <-ticker.C:
			p.Sweep(ctx)
		}
	}
}

// Sweep starts a turn for every offered panel whose poll is due and that has
// none running. It does not wait for them (Wait does).
func (p *Poller) Sweep(ctx context.Context) {
	if p.Panels == nil || p.Schedule == nil {
		return
	}
	now := p.Loop.now()
	for _, panel := range p.Panels() {
		if !panel.ReviewState.Collectable() {
			continue
		}
		at, ok := p.Schedule.NextPoll(panel.ID, PollGap(panel))
		if !ok || at.After(now) || !p.claim(panel.ID, now) {
			continue
		}
		p.wg.Add(1)
		go func(panel Panel) {
			defer p.wg.Done()
			defer p.release(panel.ID)
			p.turn(ctx, panel)
		}(panel)
	}
}

// Wait returns once every started turn has finished.
func (p *Poller) Wait() { p.wg.Wait() }

// turn is the bulk pass's turn on one panel. A panel another turn holds is
// skipped rather than waited on: that turn reads it, and the plan it makes
// moves this panel's next poll.
func (p *Poller) turn(ctx context.Context, panel Panel) {
	l := p.Loop
	if l.Turns != nil {
		release, ok := l.Turns.TryHold(panel.ID)
		if !ok {
			return
		}
		defer release()
	}
	_, op, err := l.collect(ctx, panel, PollMinWindow, true)
	if err == nil {
		return
	}
	p.mu.Lock()
	p.retry[panel.ID] = l.now().Add(PollRetry)
	p.mu.Unlock()
	if op != OpSkipped {
		l.log().Warn("planned poll not collected", "panel", panel.ID, "op", op, "error", err)
	}
}

func (p *Poller) claim(panelID string, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running == nil {
		p.running = map[string]bool{}
		p.retry = map[string]time.Time{}
	}
	if p.running[panelID] || now.Before(p.retry[panelID]) {
		return false
	}
	p.running[panelID] = true
	return true
}

func (p *Poller) release(panelID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.running, panelID)
}
