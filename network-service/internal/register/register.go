// Package register is the Go half of panel registration (F-027-aq, ADR-0080).
//
// Registration is desired state. `billing-service` writes a panel with
// `reviewState = pending`; this pass picks it up on its own tick, runs the
// acceptance questionnaire as a connection test (`Driver.Capabilities`), holds
// the answers to `Capabilities.Validate`, and writes the document and the
// verdict back. Nothing calls this service to ask: it has no route anyone
// could call (ADR-0071), and that is the reason the question is a row.
//
// Two outcomes are deliberately different:
//
//   - **A verdict** — `accepted`, `accepted_low_trust` or `refused` — is a
//     finding about what the panel can do, read off answers that validated.
//   - **No verdict** — the panel was unreachable, refused our credentials,
//     stalled, or answered a document the column would refuse. It did not
//     answer the questionnaire, so it stays `pending` and the reason is
//     recorded for the systems page. `refused` is never written for a wrong
//     password.
//
// What is deliberately not here: the Postgres-backed Store, which lands with
// the panel source beside `collect.MemoryCursors`, and the Opener that builds
// a real driver from the declared family and the vault's credentials — the
// first real family is F-027-ae.
package register

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"network-service/internal/driver"
	"network-service/internal/panelstate"
)

// DefaultRetryAfter is how long a panel whose test failed waits before it is
// tested again. Registration is rare and a person is waiting on it, so it is
// short — except after a refusal, which waits `panelstate.DefaultCooloff`.
const DefaultRetryAfter = 5 * time.Minute

// DefaultTimeout bounds one connection test. A panel that cannot answer the
// questionnaire in this long would not survive a collection pass either.
const DefaultTimeout = 30 * time.Second

// DefaultInterval is how often Run looks for pending panels.
const DefaultInterval = 30 * time.Second

// FaultKind is why a test produced no verdict: the driver's six kinds
// (`driver.FaultKind`) plus the two that happen on our side of the call. It
// mirrors `network.ConnectionTestFault`.
type FaultKind string

const (
	// FaultUnopenable: no driver could be built — an unknown family, or
	// credentials that do not decrypt.
	FaultUnopenable FaultKind = "unopenable"
	// FaultInvalidAnswers: the driver answered a document `Validate` refuses.
	// A driver bug, never a finding about the panel.
	FaultInvalidAnswers FaultKind = "invalid_answers"
)

// Pending is a panel waiting for its test, with the declaration it was
// registered under. Transport and CounterSemantics are the owner's
// declaration; the questionnaire is scoped and judged by them.
type Pending struct {
	PanelID          string
	DriverType       driver.DriverType
	Transport        driver.Transport
	CounterSemantics driver.CounterSemantics
	APIBaseURL       string
	// ClientBaseURL is where users are served their links, for a family that
	// serves them apart from its API (Hiddify's client proxy path, F-027-bg);
	// "" for none.
	ClientBaseURL string
	// Credentials is `panel.panelApiCredentials` as stored: a vault reference
	// (`vault:<tenantId>:panel_credentials:panel:<panelId>`, F-027-ar), never
	// the login. Only the Opener resolves it.
	Credentials string
	// TenantID is the reseller that owns the panel; "" is a platform panel
	// (invariant 9), the only kind PANEL_EGRESS_ALLOW_CIDRS is dialed for
	// (ADR-0095).
	TenantID string
}

// Candidate is a pending panel and its last test, if it had one.
type Candidate struct {
	Pending
	// TestedAt is `panel.connectionTestedAt`; zero means never tested, or
	// re-submitted by the owner, which clears it.
	TestedAt time.Time
	Fault    FaultKind
}

// Store is `network.panel` as this pass sees it.
type Store interface {
	// Pending returns every panel whose reviewState is `pending`.
	Pending(ctx context.Context) ([]Candidate, error)
	// Answer writes the document and the verdict, and clears any recorded
	// fault — **only while the panel is still pending at the addresses p
	// names**. False means it was not: withdrawn, decided, or given a new
	// `apiBaseUrl` / `clientBaseUrl` while the test ran (F-027-cc), and
	// nothing was written.
	Answer(ctx context.Context, p Pending, caps driver.Capabilities, state driver.ReviewState, at time.Time) (bool, error)
	// Fail records a test that produced no verdict. The panel stays pending.
	// It is held by the same guard as Answer, and false means the same.
	Fail(ctx context.Context, p Pending, fault FaultKind, detail string, at time.Time) (bool, error)
	// DuplicateStore is the registered-once check (F-027-ce).
	DuplicateStore
}

// Opener builds the driver for one panel.
type Opener interface {
	Open(ctx context.Context, p Pending) (driver.Driver, error)
}

// Registrar runs the pass.
type Registrar struct {
	Store  Store
	Opener Opener
	// Timeout bounds one panel's test. Zero is DefaultTimeout.
	Timeout time.Duration
	// Interval is Run's period. Zero is DefaultInterval.
	Interval time.Duration
	// RetryAfter is the wait after a failed test. Zero is DefaultRetryAfter.
	RetryAfter time.Duration
	Now        func() time.Time
	Log        *slog.Logger
	// Resolve looks a host up for the duplicate check's same-IP suspicion.
	// Nil is net.DefaultResolver.LookupHost.
	Resolve func(ctx context.Context, host string) ([]string, error)
}

// Failure is one panel whose test produced no verdict.
type Failure struct {
	PanelID string
	Fault   FaultKind
	Detail  string
}

// Report is what one pass did.
type Report struct {
	// Answered is how many verdicts were written.
	Answered int
	// Waiting is how many pending panels were inside their retry wait.
	Waiting int
	// Stale is how many answers — verdicts or faults — arrived for a panel no
	// longer pending, or no longer at the address that was tested.
	Stale  int
	Failed []Failure
}

// Run passes on the interval until the context ends, starting with a pass: a
// panel registered while this service was down has waited long enough.
func (r *Registrar) Run(ctx context.Context) error {
	ticker := time.NewTicker(orDefault(r.Interval, DefaultInterval))
	defer ticker.Stop()
	for {
		if _, err := r.Pass(ctx); err != nil && ctx.Err() == nil {
			r.log().Error("registration pass failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Pass tests every pending panel that is due, one at a time: registrations
// are rare, and a pass that tested them in parallel would only spend the
// connections a collection pass needs.
func (r *Registrar) Pass(ctx context.Context) (Report, error) {
	candidates, err := r.Store.Pending(ctx)
	if err != nil {
		return Report{}, err
	}
	var report Report
	for _, c := range candidates {
		if ctx.Err() != nil {
			return report, ctx.Err()
		}
		if !r.due(c) {
			report.Waiting++
			continue
		}
		if err := r.test(ctx, c.Pending, &report); err != nil {
			return report, err
		}
	}
	return report, nil
}

// due is the retry wait. A refusal (`429`/`403`) waits the cool-off every
// other loop honours, because retrying through a ban is what makes it
// permanent (F-027-v); anything else waits RetryAfter.
func (r *Registrar) due(c Candidate) bool {
	if c.TestedAt.IsZero() || c.Fault == "" {
		return true
	}
	wait := orDefault(r.RetryAfter, DefaultRetryAfter)
	if c.Fault == FaultKind(driver.FaultBlocked) || c.Fault == FaultKind(driver.FaultRateLimited) {
		wait = panelstate.DefaultCooloff
	}
	return !r.now().Before(c.TestedAt.Add(wait))
}

// test is one panel. An error returned is the store's; a panel's own failure
// is recorded and reported, never returned, so one bad panel does not stop
// the pass for the rest.
func (r *Registrar) test(ctx context.Context, p Pending, report *Report) error {
	at := r.now()
	fail := func(fault FaultKind, detail string) error {
		written, err := r.Store.Fail(ctx, p, fault, detail, at)
		if err != nil {
			return err
		}
		if !written {
			report.Stale++
			return nil
		}
		report.Failed = append(report.Failed, Failure{PanelID: p.PanelID, Fault: fault, Detail: detail})
		r.log().Warn("connection test produced no verdict", "panel", p.PanelID, "fault", fault, "detail", detail)
		return nil
	}

	d, err := r.Opener.Open(ctx, p)
	if err != nil {
		return fail(faultOf(err, FaultUnopenable), err.Error())
	}

	testCtx, cancel := context.WithTimeout(ctx, orDefault(r.Timeout, DefaultTimeout))
	caps, err := d.Capabilities(testCtx)
	cancel()
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fail(faultOf(err, FaultKind(driver.FaultProtocol)), err.Error())
	}
	if caps.AnsweredAt.IsZero() {
		caps.AnsweredAt = at
	}
	if err := caps.Validate(p.Transport); err != nil {
		return fail(FaultInvalidAnswers, err.Error())
	}

	verdict := caps.Verdict(p.Transport, p.CounterSemantics)
	// Registered once (F-027-ce): a pull panel that would be taken is first
	// asked whether it is one already registered. A refused one is not taken
	// either way, and a push panel is never called.
	if p.Transport == driver.TransportPull && verdict.ReviewState != driver.ReviewRefused {
		dupCtx, cancel := context.WithTimeout(ctx, orDefault(r.Timeout, DefaultTimeout))
		holder, found, err := r.duplicateOf(dupCtx, d, p)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fail(faultOf(err, FaultKind(driver.FaultProtocol)), err.Error())
		}
		if found {
			written, err := r.Store.Duplicate(ctx, p, caps, holder, at)
			if err != nil {
				return err
			}
			if !written {
				report.Stale++
				return nil
			}
			report.Answered++
			r.log().Warn("panel refused: it is one already registered", "panel", p.PanelID, "duplicateOf", holder.PanelID, "name", holder.Name)
			return nil
		}
	}
	written, err := r.Store.Answer(ctx, p, caps, verdict.ReviewState, at)
	if err != nil {
		return err
	}
	if !written {
		report.Stale++
		return nil
	}
	report.Answered++
	r.log().Info("panel registered", "panel", p.PanelID, "reviewState", verdict.ReviewState,
		"meteredSaleAllowed", verdict.MeteredSaleAllowed, "unmet", verdict.Unmet)
	return nil
}

// faultOf reads the kind off a driver Fault. A context deadline that a driver
// returned bare is still our timeout; anything else unclassified is fallback.
func faultOf(err error, fallback FaultKind) FaultKind {
	if kind, ok := driver.KindOf(err); ok {
		return FaultKind(kind)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return FaultKind(driver.FaultTimeout)
	}
	return fallback
}

func orDefault(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

func (r *Registrar) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now().UTC()
}

func (r *Registrar) log() *slog.Logger {
	if r.Log != nil {
		return r.Log
	}
	return slog.Default()
}
