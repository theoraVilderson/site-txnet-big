// Pacing: how often a panel may be asked, and how many callers one question
// costs (F-027-k, catalog 8.4).
//
// Two things belong to every family and to none of them in particular. A
// whole-panel read that several callers want at once is one request, not one
// each — which is exactly when a slow panel would otherwise be flooded by the
// callers waiting on it. And no panel is asked more often than its own
// `maxRequestsPerMinute`, because over it is a 429 at best (F-027-v) and our
// address banned at worst.
//
// Written once here rather than thirteen times: a family that implemented its
// own would be twelve more places for the same mistake, and the mistake is
// invisible — every byte correct, and a flood on a customer's server. The
// conformance suite asserts both properties over each family as it is paced.
//
// A page is a request (ADR-0081). A family whose bulk read is paged spends the
// budget once per page: Pace pays for the first when the call starts, and the
// driver calls NextPage before each page after it. A family that reads in one
// request never calls it, and nothing changes for it.
//
// The owner's figure is a ceiling, not a target (F-027-df, SPEC weakness #15,
// #20). A `429` or a `5xx` halves the rate the Pacer allows, down to an eighth
// of the figure, and each answer earns a sliver back, so a halved panel is at
// its owner's figure again after RecoverAfter answers. BreakAfter `5xx` in a
// row open a breaker: the calls behind them fail at once instead of each
// waiting out a timeout on a dead machine, and one probe goes after a wait
// that doubles from BreakerCooldown and never passes MaxBreakerCooldown — a
// bulk pass, so a panel that came back is seen by the next pass. The state
// lives on the Pacer rather than the wrapper, so a driver reopened on the
// same budget starts where the last one left off.
//
// What is *not* here is the per-panel wiring: reading `maxRequestsPerMinute`
// off the panel row, recording the observed rate, the cool-off after a 429 and
// alerting the owner on a 403. That is F-027-v, and it builds a Budget from
// the row and wraps the family's driver in this.

package driver

import (
	"context"
	"errors"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// MinPageSize is the smallest page a paged bulk read may use (ADR-0081). Below
// it, a pass over 5000 clients stops being a bounded handful of requests and
// starts to become the per-client flood catalog 8.4 forbids. The conformance
// suite holds a family's bulk pass to ceil(clients / MinPageSize) requests.
const MinPageSize = 100

// pacerKey carries the pacing layer through a call, so a driver's second and
// later pages pay the same budget its first did.
type pacerKey struct{}

// NextPage spends the panel's budget on one more page of the read in flight,
// waiting for room exactly as the call's first request did. Outside Pace (a
// driver used unwrapped, as in its own tests) there is no budget to spend,
// and it returns at once.
func NextPage(ctx context.Context, op string) error {
	if p, ok := ctx.Value(pacerKey{}).(*paced); ok {
		return p.pacer.acquire(ctx, op, true)
	}
	return nil
}

// Budget is one panel's request allowance, as the panel row declares it.
type Budget struct {
	// MaxRequests is `panel.maxRequestsPerMinute`. Invariant 12 makes it
	// positive in the database, because a budget of zero stops collection on
	// that panel in silence.
	MaxRequests int
	// Window is what MaxRequests is measured over. Zero means a minute, which
	// is the column's own unit; a shorter one is for a test that cannot wait
	// a minute to prove the arithmetic.
	Window time.Duration
}

// The adaptive rate and the breaker (F-027-df).
const (
	// BreakAfter is how many `unavailable` faults in a row open the breaker.
	BreakAfter = 5
	// BreakerCooldown is the first wait before a probe; each failed probe
	// doubles it.
	BreakerCooldown = 15 * time.Second
	// MaxBreakerCooldown is one bulk pass. A longer wait would hide a panel
	// that came back from the pass after, and while the breaker is open no
	// ceiling reaches the panel (user, 2026-09-27).
	MaxBreakerCooldown = time.Minute
	// RecoverAfter is how many answers take a halved rate back to the
	// owner's figure.
	RecoverAfter = 16
	// floorShare is the least share of the owner's figure a run of refusals
	// can take the rate to: three halvings. Below it a planned poll (two
	// requests) would no longer fit the budget it keeps to.
	floorShare = 8
)

// ErrCircuitOpen is what a call the breaker stopped wraps. It arrives as an
// `unavailable` fault, because that is what the breaker knows of the panel.
var ErrCircuitOpen = errors.New("driver: circuit open")

// Pace wraps a driver so that it holds its panel's request budget and shares
// one whole-panel read between concurrent callers. It is NewPacer(b).Wrap(d).
//
// It panics on a non-positive MaxRequests. That figure comes from a column the
// database CHECKs (invariant 12), so a zero here is not a panel to be handled
// gently — it is the constraint having been bypassed, and the alternative
// readings are "ask without limit" and "never ask again", both of which are
// worse when discovered later.
func Pace(d Driver, b Budget) Driver {
	return NewPacer(b).Wrap(d)
}

// Pacer is one panel's budget and what it has learned of the panel: the rate
// it allows now, and the breaker. Wrap a reopened driver in the same Pacer and
// neither is forgotten.
type Pacer struct {
	budget Budget

	mu sync.Mutex
	// sent holds the times of the requests still inside the window, oldest
	// first, and never grows past MaxRequests entries.
	sent []time.Time
	// rate is the requests per window allowed now, in [floor, MaxRequests].
	rate float64
	// fails counts `unavailable` in a row; at BreakAfter the breaker is open
	// until openUntil, then lets one probe through.
	fails     int
	openUntil time.Time
	cooldown  time.Duration
	probing   bool

	now func() time.Time
}

// NewPacer starts a panel at its owner's figure. It panics as Pace does.
func NewPacer(b Budget) *Pacer {
	if b.MaxRequests <= 0 {
		panic("driver.Pace: a request budget must be positive (network invariant 12); " +
			"zero would stop collection on this panel in silence")
	}
	if b.Window <= 0 {
		b.Window = time.Minute
	}
	return &Pacer{
		budget:   b,
		sent:     make([]time.Time, 0, b.MaxRequests),
		rate:     float64(b.MaxRequests),
		cooldown: BreakerCooldown,
		now:      time.Now,
	}
}

// Wrap paces d on this Pacer's budget.
func (pc *Pacer) Wrap(d Driver) Driver {
	return &paced{Driver: d, pacer: pc, flights: map[string]*flight{}}
}

// PacerOf is the Pacer a driver was wrapped in, if it was.
func PacerOf(d Driver) (*Pacer, bool) {
	p, ok := d.(*paced)
	if !ok {
		return nil, false
	}
	return p.pacer, true
}

// Budget is the owner's figure this Pacer holds to.
func (pc *Pacer) Budget() Budget { return pc.budget }

// Rate is the requests per Budget().Window the Pacer allows now.
func (pc *Pacer) Rate() float64 {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	return pc.rate
}

// report is what one call's outcome teaches the Pacer. A timeout, and an error
// that is not a Fault, say nothing of the panel; any other answer closes the
// breaker, because the panel answered.
func (pc *Pacer) report(err error) {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	var f *Fault
	kind := FaultKind("")
	if errors.As(err, &f) {
		kind = f.Kind
	}
	most := float64(pc.budget.MaxRequests)
	switch {
	case err == nil:
		pc.rate = math.Min(most, pc.rate+most/(2*RecoverAfter))
		pc.close()
	case kind == FaultRateLimited:
		pc.halve()
		pc.close()
	case kind == FaultUnavailable:
		pc.halve()
		pc.probing = false
		pc.fails++
		if pc.fails >= BreakAfter {
			pc.openUntil = pc.now().Add(pc.cooldown)
			pc.cooldown = min(2*pc.cooldown, MaxBreakerCooldown)
		}
	case kind == FaultTimeout || kind == "":
		pc.probing = false
	default:
		pc.close()
	}
}

func (pc *Pacer) halve() {
	floor := math.Max(1, float64(pc.budget.MaxRequests)/floorShare)
	pc.rate = math.Max(floor, pc.rate/2)
}

func (pc *Pacer) close() {
	pc.fails, pc.probing, pc.cooldown, pc.openUntil = 0, false, BreakerCooldown, time.Time{}
}

// paced embeds the family's driver, so a method it does not pace passes
// straight through — SubscriptionURL, which takes no context and reaches
// nothing, is the only one.
type paced struct {
	Driver
	pacer *Pacer

	mu      sync.Mutex
	flights map[string]*flight
}

// flight is one call several callers are waiting on.
type flight struct {
	done chan struct{}
	val  any
	err  error
}

// acquire blocks until this request fits inside the budget, or the caller's
// deadline passes. It waits rather than failing: a dropped read is a gap in a
// counter somebody is billed from, and the panel would have answered it a
// moment later (invariant 18). The one exception is an open breaker, which
// fails the call at once. A later page of a call already admitted is not
// asked again — it is the same call, and may be the probe.
func (pc *Pacer) acquire(ctx context.Context, op string, page bool) error {
	for {
		pc.mu.Lock()
		now := pc.now()
		broken := pc.fails >= BreakAfter
		if !page && broken && (now.Before(pc.openUntil) || pc.probing) {
			pc.mu.Unlock()
			return NewFault(FaultUnavailable, op, 0, ErrCircuitOpen)
		}
		kept := pc.sent[:0]
		for _, at := range pc.sent {
			if now.Sub(at) < pc.budget.Window {
				kept = append(kept, at)
			}
		}
		pc.sent = kept
		if len(pc.sent) < max(1, int(pc.rate)) {
			pc.sent = append(pc.sent, now)
			if !page && broken {
				pc.probing = true
			}
			pc.mu.Unlock()
			return nil
		}
		wait := pc.budget.Window - now.Sub(pc.sent[0])
		pc.mu.Unlock()

		timer := time.NewTimer(wait)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return NewFault(FaultTimeout, op, 0, ctx.Err())
		}
	}
}

// share collapses concurrent identical reads into one request. The caller that
// opens the flight is the one that spends the budget; the rest wait on its
// answer and spend nothing.
//
// The shared call runs under the opening caller's context, so a joiner with a
// longer deadline is bounded by the leader's. That is the safe direction: the
// alternative is a call outliving the caller that authorised it, and the
// loop's budget is per panel.
func share[T any](ctx context.Context, p *paced, op, key string, call func(context.Context) (T, error)) (T, error) {
	var zero T
	p.mu.Lock()
	if joined, ok := p.flights[key]; ok {
		p.mu.Unlock()
		select {
		case <-joined.done:
		case <-ctx.Done():
			return zero, NewFault(FaultTimeout, op, 0, ctx.Err())
		}
		val, _ := joined.val.(T)
		return val, joined.err
	}
	f := &flight{done: make(chan struct{})}
	p.flights[key] = f
	p.mu.Unlock()

	// The flight is registered before the budget is waited on, so callers
	// arriving while the leader waits for its slot join it instead of queuing
	// behind it for a second request.
	val, err := zero, p.pacer.acquire(ctx, op, false)
	if err == nil {
		val, err = call(context.WithValue(ctx, pacerKey{}, p))
		p.pacer.report(err)
	}

	p.mu.Lock()
	delete(p.flights, key)
	p.mu.Unlock()
	f.val, f.err = val, err
	close(f.done)
	return val, err
}

// spend is the write path and every call that is not a shareable read: it pays
// the budget and goes. Two identical writes are two intentions and are never
// collapsed — the second one is not the first one happening again.
func (p *paced) spend(ctx context.Context, op string, call func(context.Context) error) error {
	if err := p.pacer.acquire(ctx, op, false); err != nil {
		return err
	}
	err := call(context.WithValue(ctx, pacerKey{}, p))
	p.pacer.report(err)
	return err
}

// ---- the shared reads ------------------------------------------------------
//
// A whole-panel read has one answer at one moment, so two callers asking at
// once are asking the same question. GetUsageFor is keyed by the clients it
// names: two hot passes over the same subset share, and two over different
// subsets do not, because the second one's answer is not in the first one's.

func (p *paced) Capabilities(ctx context.Context) (Capabilities, error) {
	return share(ctx, p, "Capabilities", "Capabilities", func(ctx context.Context) (Capabilities, error) {
		return p.Driver.Capabilities(ctx)
	})
}

func (p *paced) ListInbounds(ctx context.Context) ([]Inbound, error) {
	return share(ctx, p, "ListInbounds", "ListInbounds", func(ctx context.Context) ([]Inbound, error) {
		return p.Driver.ListInbounds(ctx)
	})
}

func (p *paced) ListClients(ctx context.Context) ([]RemoteClient, error) {
	return share(ctx, p, "ListClients", "ListClients", func(ctx context.Context) ([]RemoteClient, error) {
		return p.Driver.ListClients(ctx)
	})
}

func (p *paced) GetUsage(ctx context.Context) ([]ClientUsage, error) {
	return share(ctx, p, "GetUsage", "GetUsage", func(ctx context.Context) ([]ClientUsage, error) {
		return p.Driver.GetUsage(ctx)
	})
}

// ClientTotals is the family's TotalsReader, paced (TotalsOf says whether it
// has one).
func (p *paced) ClientTotals(ctx context.Context) ([]ClientUsage, error) {
	return share(ctx, p, "ClientTotals", "ClientTotals", func(ctx context.Context) ([]ClientUsage, error) {
		r, ok := p.Driver.(TotalsReader)
		if !ok {
			return nil, NewFault(FaultUnsupported, "ClientTotals", 0, errors.New("this family keeps no per-client total"))
		}
		return r.ClientTotals(ctx)
	})
}

func (p *paced) GetUsageFor(ctx context.Context, remoteIDs []string) ([]ClientUsage, error) {
	return share(ctx, p, "GetUsageFor", usageForKey(remoteIDs), func(ctx context.Context) ([]ClientUsage, error) {
		return p.Driver.GetUsageFor(ctx, remoteIDs)
	})
}

// usageForKey names the subset independently of the order it was asked in.
func usageForKey(remoteIDs []string) string {
	sorted := make([]string, len(remoteIDs))
	copy(sorted, remoteIDs)
	sort.Strings(sorted)
	return "GetUsageFor\x00" + strings.Join(sorted, "\x00")
}

// ---- the rest --------------------------------------------------------------

func (p *paced) HealthCheck(ctx context.Context) error {
	return p.spend(ctx, "HealthCheck", func(ctx context.Context) error { return p.Driver.HealthCheck(ctx) })
}

func (p *paced) CreateClient(ctx context.Context, req CreateClientRequest) (RemoteClient, error) {
	var out RemoteClient
	err := p.spend(ctx, "CreateClient", func(ctx context.Context) error {
		var err error
		out, err = p.Driver.CreateClient(ctx, req)
		return err
	})
	return out, err
}

func (p *paced) UpdateClient(ctx context.Context, req UpdateClientRequest) error {
	return p.spend(ctx, "UpdateClient", func(ctx context.Context) error { return p.Driver.UpdateClient(ctx, req) })
}

func (p *paced) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	return p.spend(ctx, "SetClientEnabled", func(ctx context.Context) error { return p.Driver.SetClientEnabled(ctx, remoteID, enabled) })
}

func (p *paced) DeleteClient(ctx context.Context, remoteID string) error {
	return p.spend(ctx, "DeleteClient", func(ctx context.Context) error { return p.Driver.DeleteClient(ctx, remoteID) })
}

func (p *paced) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	return p.spend(ctx, "SetClientDataLimit", func(ctx context.Context) error {
		return p.Driver.SetClientDataLimit(ctx, remoteID, ceilingBytes)
	})
}

func (p *paced) SetClientRateLimit(ctx context.Context, remoteID string, rateBps int64) error {
	return p.spend(ctx, "SetClientRateLimit", func(ctx context.Context) error {
		return p.Driver.SetClientRateLimit(ctx, remoteID, rateBps)
	})
}

func (p *paced) ResetUsage(ctx context.Context, remoteID string) error {
	return p.spend(ctx, "ResetUsage", func(ctx context.Context) error { return p.Driver.ResetUsage(ctx, remoteID) })
}

func (p *paced) BuildLink(ctx context.Context, client RemoteClient, inbound Inbound) (string, error) {
	var out string
	err := p.spend(ctx, "BuildLink", func(ctx context.Context) error {
		var err error
		out, err = p.Driver.BuildLink(ctx, client, inbound)
		return err
	})
	return out, err
}

func (p *paced) ClientLinks(ctx context.Context, client RemoteClient) ([]string, error) {
	var out []string
	err := p.spend(ctx, "ClientLinks", func(ctx context.Context) error {
		var err error
		out, err = p.Driver.ClientLinks(ctx, client)
		return err
	})
	return out, err
}
