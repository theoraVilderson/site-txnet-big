package register_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/panelstate"
	"network-service/internal/register"
)

// Registration is desired state (ADR-0080): `billing-service` writes a panel
// as `pending`, and this pass is the only thing that turns it into a verdict.
// Every test here runs the real questionnaire against the fake panel, because
// a verdict proved against a stubbed Verdict proves the stub.

var t0 = time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)

// opener hands out one fake per panel id, the way the real one will build a
// driver from `driverType`, `apiBaseUrl` and the decrypted credentials.
type opener struct {
	panels map[string]driver.Driver
	err    error
}

func (o opener) Open(_ context.Context, p register.Pending) (driver.Driver, error) {
	if o.err != nil {
		return nil, o.err
	}
	d, ok := o.panels[p.PanelID]
	if !ok {
		return nil, errors.New("no driver for " + p.PanelID)
	}
	return d, nil
}

type clock struct{ at time.Time }

func (c *clock) now() time.Time { return c.at }

func pending(id string, transport driver.Transport, semantics driver.CounterSemantics) register.Pending {
	return register.Pending{
		PanelID: id, DriverType: driver.DriverFake,
		Transport: transport, CounterSemantics: semantics,
		APIBaseURL: "https://" + id + ".example",
	}
}

func setup(panels map[string]driver.Driver, rows ...register.Pending) (*register.Registrar, *register.MemoryStore, *clock) {
	store := register.NewMemoryStore()
	for _, p := range rows {
		store.Put(p)
	}
	c := &clock{at: t0}
	return &register.Registrar{
		Store:   store,
		Opener:  opener{panels: panels},
		Timeout: 50 * time.Millisecond,
		Now:     c.now,
	}, store, c
}

func pass(t *testing.T, r *register.Registrar) register.Report {
	t.Helper()
	report, err := r.Pass(context.Background())
	if err != nil {
		t.Fatalf("Pass: %v", err)
	}
	return report
}

// The four verdicts ADR-0074 names, each reached by what the panel actually
// does rather than by what it was declared to be.
func TestTheConnectionTestDecidesTheVerdict(t *testing.T) {
	for _, tc := range []struct {
		name      string
		config    fake.Config
		wantState driver.ReviewState
	}{
		{"a panel that can do everything is accepted",
			fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative},
			driver.ReviewAccepted},
		{"a panel that cannot disable a client is refused here, before it has users",
			fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative,
				Unsupported: map[driver.RowKey]bool{driver.RowEnableDisableClient: true}},
			driver.ReviewRefused},
		{"a panel with no ceiling is accepted — metered sale is withheld, not the panel",
			fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative,
				Unsupported: map[driver.RowKey]bool{driver.RowPerClientDataLimit: true}},
			driver.ReviewAccepted},
		{"reset_on_read is accepted only as low trust",
			fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterResetOnRead},
			driver.ReviewAcceptedLowTrust},
		{"a push source is asked its own rows and not the pull ones",
			fake.Config{Transport: driver.TransportPush, CounterSemantics: driver.CounterSession},
			driver.ReviewAccepted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, store, _ := setup(map[string]driver.Driver{"p1": fake.New(tc.config)},
				pending("p1", tc.config.Transport, tc.config.CounterSemantics))

			report := pass(t, r)

			rec := store.Record("p1")
			if rec.ReviewState != tc.wantState {
				t.Fatalf("reviewState = %s, want %s", rec.ReviewState, tc.wantState)
			}
			if rec.Capabilities == nil {
				t.Fatal("a verdict was written with no capabilities document behind it")
			}
			if err := rec.Capabilities.Validate(tc.config.Transport); err != nil {
				t.Errorf("the stored document is one the column would refuse: %v", err)
			}
			if rec.Fault != "" || !rec.TestedAt.Equal(t0) {
				t.Errorf("fault = %q, testedAt = %v; want none at %v", rec.Fault, rec.TestedAt, t0)
			}
			if report.Answered != 1 || len(report.Failed) != 0 {
				t.Errorf("report = %+v, want one answered and no failures", report)
			}
		})
	}
}

// A panel we could not reach did not answer the questionnaire, so it gets no
// verdict at all: `refused` is a finding about what a panel can do, and a
// wrong password is not one. It stays `pending`, with the reason recorded for
// the systems page, and is tried again after a wait.
func TestAFailedTestLeavesThePanelPendingAndSaysWhy(t *testing.T) {
	for _, tc := range []struct {
		name  string
		fail  func(p *fake.Panel)
		fault register.FaultKind
		retry time.Duration
	}{
		{"a failing panel", func(p *fake.Panel) { p.FailNextCall(503) }, register.FaultKind(driver.FaultUnavailable), register.DefaultRetryAfter},
		{"a stalled panel", func(p *fake.Panel) { p.StallNextCall(time.Second) }, register.FaultKind(driver.FaultTimeout), register.DefaultRetryAfter},
		// A refusal is not retried through (F-027-v): the owner has a
		// credential to fix, and asking again every few minutes is how an
		// address gets banned for good.
		{"a panel refusing our credentials", func(p *fake.Panel) { p.FailNextCall(401) }, register.FaultKind(driver.FaultBlocked), panelstate.DefaultCooloff},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := fake.New(fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative})
			tc.fail(p)
			r, store, c := setup(map[string]driver.Driver{"p1": p},
				pending("p1", driver.TransportPull, driver.CounterCumulative))

			report := pass(t, r)

			rec := store.Record("p1")
			if rec.ReviewState != driver.ReviewPending || rec.Capabilities != nil {
				t.Fatalf("reviewState = %s, capabilities = %v; a test that did not answer wrote a verdict",
					rec.ReviewState, rec.Capabilities)
			}
			if rec.Fault != tc.fault || rec.Detail == "" || !rec.TestedAt.Equal(t0) {
				t.Errorf("recorded %q (%q) at %v, want %q with a detail at %v", rec.Fault, rec.Detail, rec.TestedAt, tc.fault, t0)
			}
			if len(report.Failed) != 1 || report.Failed[0].Fault != tc.fault {
				t.Errorf("report.Failed = %+v", report.Failed)
			}

			c.at = t0.Add(tc.retry - time.Second)
			if report := pass(t, r); report.Waiting != 1 || p.CallCount("Capabilities") != 1 {
				t.Errorf("asked again %v later, inside its wait: report %+v, %d tests", tc.retry-time.Second, report, p.CallCount("Capabilities"))
			}

			c.at = t0.Add(tc.retry)
			pass(t, r)
			if rec := store.Record("p1"); rec.ReviewState != driver.ReviewAccepted || rec.Fault != "" {
				t.Errorf("after the wait: reviewState = %s, fault = %q; want accepted with the fault cleared", rec.ReviewState, rec.Fault)
			}
		})
	}
}

// capsOnly answers the questionnaire with a fixed document, so a driver bug
// can be staged without teaching the fake to misbehave in this one way.
type capsOnly struct {
	driver.Driver
	caps driver.Capabilities
}

func (c capsOnly) Capabilities(context.Context) (driver.Capabilities, error) { return c.caps, nil }

// A document the column would refuse is never written, and no verdict is read
// off it: a missing row is a silence, and Verdict reads silence as "no" — a
// driver that forgot a row would get its panel refused, or worse, accepted
// under a row it never tested.
func TestADocumentThatFailsValidationIsNeverStored(t *testing.T) {
	base := fake.New(fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative})
	caps, err := base.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	delete(caps.Answers, driver.RowPerClientDataLimit)

	r, store, _ := setup(map[string]driver.Driver{"p1": capsOnly{Driver: base, caps: caps}},
		pending("p1", driver.TransportPull, driver.CounterCumulative))
	pass(t, r)

	rec := store.Record("p1")
	if rec.ReviewState != driver.ReviewPending || rec.Capabilities != nil {
		t.Fatalf("reviewState = %s; an invalid document produced a verdict", rec.ReviewState)
	}
	if rec.Fault != register.FaultInvalidAnswers {
		t.Errorf("fault = %q, want %q", rec.Fault, register.FaultInvalidAnswers)
	}
}

// A driver that cannot be built — an unknown family, credentials that do not
// decrypt — is the same kind of outcome as an unreachable panel: no answer, so
// no verdict.
func TestAPanelThatCannotBeOpenedIsNotAnswered(t *testing.T) {
	r, store, _ := setup(nil, pending("p1", driver.TransportPull, driver.CounterCumulative))
	r.Opener = opener{err: errors.New("credentials do not decrypt")}

	pass(t, r)

	if rec := store.Record("p1"); rec.ReviewState != driver.ReviewPending || rec.Fault != register.FaultUnopenable {
		t.Errorf("reviewState = %s, fault = %q; want pending and %q", rec.ReviewState, rec.Fault, register.FaultUnopenable)
	}
}

// The verdict is written only over `pending`. If the owner withdrew or
// re-submitted the panel while its test was running, the answer is to a
// question nobody is asking any more.
func TestAVerdictIsWrittenOnlyOverPending(t *testing.T) {
	p := fake.New(fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative})
	r, store, _ := setup(nil, pending("p1", driver.TransportPull, driver.CounterCumulative))
	r.Opener = opener{panels: map[string]driver.Driver{"p1": withdrawing{Driver: p, store: store}}}

	report := pass(t, r)

	if rec := store.Record("p1"); rec.ReviewState != driver.ReviewRefused || rec.Capabilities != nil {
		t.Errorf("reviewState = %s; the late verdict overwrote a decision made while the test ran", rec.ReviewState)
	}
	if report.Stale != 1 || report.Answered != 0 {
		t.Errorf("report = %+v, want one stale answer and none written", report)
	}
}

// withdrawing moves the panel off `pending` while its test is in flight.
type withdrawing struct {
	driver.Driver
	store *register.MemoryStore
}

func (w withdrawing) Capabilities(ctx context.Context) (driver.Capabilities, error) {
	w.store.Decide("p1", driver.ReviewRefused)
	return w.Driver.Capabilities(ctx)
}

// F-027-cc: a test's answer is about the server it reached. An owner who
// changed the address while it ran gets a test of the new one, not the old
// one's verdict — and not its fault either, which would hold the new address
// in a retry wait it never earned.
func TestAnAnswerLandsOnlyForTheAddressItTested(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*register.MemoryStore)
	}{
		{"the API address", func(s *register.MemoryStore) { s.Edit("p1", "https://moved.example", "") }},
		{"the link address", func(s *register.MemoryStore) { s.Edit("p1", "https://p1.example", "https://cdn.example") }},
	} {
		for _, answer := range []string{"verdict", "fault"} {
			t.Run(tc.name+" / "+answer, func(t *testing.T) {
				p := fake.New(fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative})
				if answer == "fault" {
					p.FailNextCall(503)
				}
				r, store, _ := setup(nil, pending("p1", driver.TransportPull, driver.CounterCumulative))
				r.Opener = opener{panels: map[string]driver.Driver{"p1": editing{Driver: p, store: store, edit: tc.edit}}}

				report := pass(t, r)

				rec := store.Record("p1")
				if rec.ReviewState != driver.ReviewPending || rec.Capabilities != nil || rec.Fault != "" || !rec.TestedAt.IsZero() {
					t.Errorf("record = %+v; the old address's %s landed on the new one", rec, answer)
				}
				if report.Stale != 1 || report.Answered != 0 || len(report.Failed) != 0 {
					t.Errorf("report = %+v, want one stale answer and nothing written", report)
				}
			})
		}
	}
}

// editing changes the panel's address while its test is in flight.
type editing struct {
	driver.Driver
	store *register.MemoryStore
	edit  func(*register.MemoryStore)
}

func (e editing) Capabilities(ctx context.Context) (driver.Capabilities, error) {
	e.edit(e.store)
	return e.Driver.Capabilities(ctx)
}

// Only accepted panels are collected. The collection loop's own guard is
// asserted in `collect`; this is the rule it reads.
func TestOnlyAnAcceptedVerdictIsCollectable(t *testing.T) {
	for state, want := range map[driver.ReviewState]bool{
		driver.ReviewAccepted:         true,
		driver.ReviewAcceptedLowTrust: true,
		driver.ReviewPending:          false,
		driver.ReviewRefused:          false,
		"":                            false,
	} {
		if got := state.Collectable(); got != want {
			t.Errorf("%q.Collectable() = %v, want %v", state, got, want)
		}
	}
}
