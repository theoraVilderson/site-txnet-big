// Package shutdown extends every active ceiling to what the user's money still
// backs, before the collector exits (F-027-w, ADR-0078).
//
// **A deploy must not cut anybody off.** The collector is the only thing that
// reads a panel's counters, so while it is down nothing measures, nothing buys
// and no ceiling rises. The hot loop sizes a block at about two minutes of the
// user's own rate (`contract.hot-loop.md`), which is the right figure while
// somebody is watching and far too small the moment nobody is: a weekly deploy
// is several minutes in which every metered user runs into a ceiling, with
// money in their wallet and nothing wrong anywhere. Crashes are rare and
// deploys are weekly, so the graceful path is the one that matters.
//
// **The ceiling is extended, not removed.** Writing no limit would serve
// traffic against nobody's purchase, which is the hole ADR-0072 exists to
// close, and it would do it at the one moment nothing is measuring how much.
// So the new figure is bounded by money that exists — the config's share of
// `purchasedBytes` plus what the wallet would buy at the Grant's locked rate,
// which `billing-service` computes and leaves in
// `config.walletBackedCeilingBytes` (ADR-0078).
//
// Four rules follow, and each is a refusal rather than a preference:
//
//   - **It only ever raises.** A panel already enforcing more than the figure
//     is left alone. A shutdown that lowered a ceiling would be the cut-off
//     this package exists to prevent, arriving from the code meant to prevent
//     it.
//   - **Zero is never written.** Zero read off a panel means *no limit*
//     (`driver.RemoteClient`), so writing it is the one mistake here that
//     hands out free traffic. A user whose money has run out keeps the ceiling
//     they had; cutting them off for real is F-027-x's and F-027-z's.
//   - **It is still somebody else's server.** The budget, the single flight
//     and the ban all hold on the way out — a ban earned during a deploy is
//     one nobody is watching for, and the next start inherits it.
//   - **It records nothing on our side.** No cursor moves, no
//     `appliedCeilingBytes` is written. The panel is deliberately left holding
//     more than `allocatedCeilingBytes`, and the first convergence pass after
//     the restart sees exactly that and pulls it back down as
//     `above_allocation` (F-027-t). The repair is the existing loop's, which
//     is also what makes an *ungraceful* exit recoverable: the extension is
//     never a state anything has to remember.
package shutdown

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"network-service/internal/collect"
	"network-service/internal/converge"
)

// DefaultPanelTimeout is how long one panel may hold its own slice of the exit
// budget. It is shorter than the collection pass's ten seconds because the
// whole budget is shorter: a container gets one `SHUTDOWN_TIMEOUT` and the
// HTTP server is draining out of the same one.
const DefaultPanelTimeout = 5 * time.Second

// DefaultConcurrency bounds how many panels are written at once, for the same
// reason the collection pass bounds its reads: a fan-out over two hundred
// panels from one exiting process is a burst nobody sized for.
const DefaultConcurrency = 8

// Extension is one config's ceiling as money, rather than measurement, bounds
// it. Both figures are in **lifetime bytes for that config** — the basis
// `purchasedBytes` is counted on — and the translation into the panel's own
// counter origin happens here, through the same function F-027-t uses.
type Extension struct {
	ConfigID string
	// RemoteID is `config.remoteId`. Empty means the config was never created
	// at the far end; there is nothing to write to.
	RemoteID string
	// AllocatedBytes is `config.allocatedCeilingBytes` — the share in force
	// while the collector is running.
	AllocatedBytes int64
	// WalletBackedBytes is `config.walletBackedCeilingBytes` — that share over
	// a bag of `purchasedBytes` plus what the wallet would still buy. Never
	// below AllocatedBytes; the database CHECKs it
	// (`config_wallet_backed_ceiling_extends`).
	WalletBackedBytes int64
}

// Reserves is where those figures come from — `network.config` behind an
// interface, so the extension is proved against scripted panels the way the
// collection loop is.
type Reserves interface {
	Extensions(ctx context.Context, panelID string) ([]Extension, error)
}

// Finding is one config the extension did something about, or could not.
type Finding struct {
	PanelID  string
	ConfigID string
	RemoteID string
	// FromBytes and ToBytes are in the **panel's** basis: what it was
	// enforcing, and what it was raised to.
	FromBytes int64
	ToBytes   int64
	// Err is set where the panel refused the write, and is always a
	// *driver.Fault.
	Err error
}

// Report is what the exit managed, for the last log line the process writes.
// It is the only record: nothing here is persisted, by design.
type Report struct {
	Panels   int
	Checked  int
	Raised   int
	Skipped  int
	Refused  int
	Failed   int
	Findings []Finding
}

// Extender runs the extension over every panel. It holds no state of its own.
type Extender struct {
	Source   collect.Source
	Reserves Reserves
	// Counters is the collector's memory of where each counter was, read and
	// never moved — `collect.Cursors` satisfies it.
	Counters converge.Counters
	// Health gates what may be asked (F-027-v). Nil asks every panel.
	Health collect.PanelHealth
	// Turns is the per-panel lock the loops hold (F-027-bu). A turn still
	// running when the loops were told to stop finishes before this panel is
	// written, so its ceiling pass cannot pull the extension straight back
	// down. Nil takes no lock.
	Turns *collect.TurnLocks

	// PanelTimeout bounds one panel's slice of the exit budget.
	PanelTimeout time.Duration
	// Concurrency bounds panels in flight.
	Concurrency int
	Clock       func() time.Time
	Log         *slog.Logger
}

// Run extends every panel's ceilings once, and returns when the last one is
// done or the context ends.
//
// The caller's context carries the exit deadline, so a shutdown budget that
// runs out leaves the panels it did reach extended and the rest where they
// were. That is the right partial result: every panel it got to is a set of
// users who are not cut off, and a panel it did not is no worse off than if
// this package did not exist.
//
// It returns an error only where the panel list itself could not be read. A
// panel that refuses or fails is a finding, because one unreachable panel must
// not leave the other hundred's users cut off for the length of a deploy.
func (e *Extender) Run(ctx context.Context) (Report, error) {
	panels, err := e.Source.Panels(ctx)
	if err != nil {
		return Report{}, err
	}

	report := Report{Panels: len(panels)}
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, e.concurrency())

	for _, panel := range panels {
		wg.Add(1)
		go func(p collect.Panel) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-slots }()
			if e.Turns != nil {
				defer e.Turns.Hold(p.ID)()
			}

			one := e.extend(ctx, p)

			mu.Lock()
			defer mu.Unlock()
			report.Checked += one.Checked
			report.Raised += one.Raised
			report.Skipped += one.Skipped
			report.Refused += one.Refused
			report.Failed += one.Failed
			report.Findings = append(report.Findings, one.Findings...)
		}(panel)
	}
	wg.Wait()

	e.log().Info("ceilings extended for shutdown",
		"panels", report.Panels, "raised", report.Raised,
		"skipped", report.Skipped, "refused", report.Refused, "failed", report.Failed)
	return report, nil
}

// extend is one panel's turn: one read of what it is enforcing, then one write
// per config whose ceiling money says may be higher.
func (e *Extender) extend(ctx context.Context, p collect.Panel) Report {
	report := Report{}

	if e.Health != nil && !e.Health.Ask(p.ID, e.now()) {
		// A ban is a ban. Retrying through one is what makes it permanent
		// (F-027-v), and the worst moment to earn a permanent ban is the one
		// nobody is watching — the next start inherits it.
		report.Refused++
		return report
	}

	extensions, err := e.Reserves.Extensions(ctx, p.ID)
	if err != nil {
		report.Failed++
		report.Findings = append(report.Findings, Finding{PanelID: p.ID, Err: err})
		return report
	}
	if len(extensions) == 0 {
		return report
	}

	panelCtx, cancel := context.WithTimeout(ctx, e.panelTimeout())
	defer cancel()

	// One request for the whole population, exactly as the bulk usage read is
	// (catalog 8.4, invariant 34). The rule does not stop applying because the
	// process is exiting — and a flood during a deploy is the one nobody is
	// watching.
	clients, err := p.Driver.ListClients(panelCtx)
	if err != nil {
		report.Failed++
		report.Findings = append(report.Findings, Finding{PanelID: p.ID, Err: err})
		return report
	}
	enforcing := make(map[string]int64, len(clients))
	for _, client := range clients {
		enforcing[client.RemoteID] = client.DataLimitBytes
	}

	for _, ext := range extensions {
		report.Checked++
		have, onPanel := enforcing[ext.RemoteID]
		if ext.RemoteID == "" || !onPanel {
			// Nothing to write to, and a shutdown is not the moment to start
			// creating clients. Which of the drift verdicts this is belongs to
			// F-027-aa.
			report.Skipped++
			continue
		}

		offset := converge.OffsetBytes(e.Counters, p, ext.RemoteID)
		want := converge.PanelCeiling(e.allowance(ext), offset)
		if want <= 0 || want <= have {
			// Nothing to give, or the panel already holds more. Either way the
			// figure it has is the one it keeps: this only ever extends, and
			// zero would read as *no limit* at the far end.
			report.Skipped++
			continue
		}

		if err := p.Driver.SetClientDataLimit(panelCtx, ext.RemoteID, want); err != nil {
			report.Failed++
			report.Findings = append(report.Findings, Finding{
				PanelID: p.ID, ConfigID: ext.ConfigID, RemoteID: ext.RemoteID,
				FromBytes: have, ToBytes: want, Err: err,
			})
			continue
		}
		report.Raised++
		report.Findings = append(report.Findings, Finding{
			PanelID: p.ID, ConfigID: ext.ConfigID, RemoteID: ext.RemoteID,
			FromBytes: have, ToBytes: want,
		})
	}
	return report
}

// allowance is the larger of the two figures. The database CHECKs that it is
// the wallet-backed one (`config_wallet_backed_ceiling_extends`), so this is
// the reading of a row that got past the constraint — never a repair of one:
// taking the smaller would be a shutdown that lowers a ceiling.
func (e *Extender) allowance(ext Extension) int64 {
	if ext.WalletBackedBytes > ext.AllocatedBytes {
		return ext.WalletBackedBytes
	}
	return ext.AllocatedBytes
}

func (e *Extender) panelTimeout() time.Duration {
	if e.PanelTimeout > 0 {
		return e.PanelTimeout
	}
	return DefaultPanelTimeout
}

func (e *Extender) concurrency() int {
	if e.Concurrency > 0 {
		return e.Concurrency
	}
	return DefaultConcurrency
}

func (e *Extender) now() time.Time {
	if e.Clock != nil {
		return e.Clock().UTC()
	}
	return time.Now().UTC()
}

func (e *Extender) log() *slog.Logger {
	if e.Log != nil {
		return e.Log
	}
	return slog.Default()
}
