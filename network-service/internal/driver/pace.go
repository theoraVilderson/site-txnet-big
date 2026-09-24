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
// What is *not* here is the per-panel wiring: reading `maxRequestsPerMinute`
// off the panel row, recording the observed rate, backing off on a 429 and
// alerting the owner on a 403. That is F-027-v, and it builds a Budget from
// the row and wraps the family's driver in this.

package driver

import (
	"context"
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
		return p.acquire(ctx, op)
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

// Pace wraps a driver so that it holds its panel's request budget and shares
// one whole-panel read between concurrent callers.
//
// It panics on a non-positive MaxRequests. That figure comes from a column the
// database CHECKs (invariant 12), so a zero here is not a panel to be handled
// gently — it is the constraint having been bypassed, and the alternative
// readings are "ask without limit" and "never ask again", both of which are
// worse when discovered later.
func Pace(d Driver, b Budget) Driver {
	if b.MaxRequests <= 0 {
		panic("driver.Pace: a request budget must be positive (network invariant 12); " +
			"zero would stop collection on this panel in silence")
	}
	if b.Window <= 0 {
		b.Window = time.Minute
	}
	return &paced{
		Driver:  d,
		budget:  b,
		sent:    make([]time.Time, 0, b.MaxRequests),
		flights: map[string]*flight{},
	}
}

// paced embeds the family's driver, so a method it does not pace passes
// straight through — SubscriptionURL, which takes no context and reaches
// nothing, is the only one.
type paced struct {
	Driver
	budget Budget

	mu sync.Mutex
	// sent holds the times of the requests still inside the window, oldest
	// first, and never grows past MaxRequests entries.
	sent    []time.Time
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
// moment later (invariant 18).
func (p *paced) acquire(ctx context.Context, op string) error {
	for {
		p.mu.Lock()
		now := time.Now()
		kept := p.sent[:0]
		for _, at := range p.sent {
			if now.Sub(at) < p.budget.Window {
				kept = append(kept, at)
			}
		}
		p.sent = kept
		if len(p.sent) < p.budget.MaxRequests {
			p.sent = append(p.sent, now)
			p.mu.Unlock()
			return nil
		}
		wait := p.budget.Window - now.Sub(p.sent[0])
		p.mu.Unlock()

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
	val, err := zero, p.acquire(ctx, op)
	if err == nil {
		val, err = call(context.WithValue(ctx, pacerKey{}, p))
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
	if err := p.acquire(ctx, op); err != nil {
		return err
	}
	return call(context.WithValue(ctx, pacerKey{}, p))
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
