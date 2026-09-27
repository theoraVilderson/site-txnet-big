// Package converge carries an allocated ceiling to the panel that enforces it
// (F-027-t, ADR-0072).
//
// The allocator decides how much of a Grant's purchased bytes each config may
// carry and stops at `config.allocatedCeilingBytes`
// (`contract.ceiling.md`). Nothing has been enforced at that point: the
// number is ours, written on our own side, and the panel is still holding
// whatever it was last told. This package closes that gap, and it is the
// enforcement point ADR-0072 rests on — the one that keeps working while this
// service is down.
//
// Three rules shape it, and none of them is a preference:
//
//   - **`applied` is what the panel confirmed, never what we sent.** A write
//     that returned nil is not a ceiling that is being enforced: families take
//     one late, and a believed ceiling is worse than a missing one because the
//     traffic past it is served with nothing red anywhere. So the figure is
//     read back off `ListClients` and never off our own call.
//   - **The allowance is translated into the counter's own origin.** An
//     allocation is counted in lifetime bytes for that config; a panel
//     enforces against its own counter, which a restore or an operator can
//     zero. A 42 GB ceiling over a counter someone zeroed is 42 free
//     gigabytes, so the ceiling is restated in the same pass that sees the
//     reset.
//   - **The translation only ever lowers.** Bytes the panel's counter holds
//     that we never billed — what ran before we started watching — are not
//     given headroom. Covering them would serve traffic against nobody's
//     purchase; refusing to is a user who stalls, which is this decision's
//     accepted worst failure in every direction.
//
// What is deliberately not here: sizing a share (that is the allocator's),
// creating, enabling or deleting a client (`provision.go`, F-027-z) and
// deciding which config a remote client belongs to (F-027-aa). This pass writes
// one number and reads it back — and holds the one write the anti-flap stop
// bounds (F-027-ab): raising a ceiling somebody else lowered.
package converge

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sort"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
)

// Counters is the collector's memory of where each counter was — satisfied by
// `collect.Cursors`. Convergence reads it and never moves it: the cursor is
// the collection pass's to advance, after its publish succeeded.
type Counters interface {
	Counter(panelID, remoteID string) (collect.Counter, bool)
}

// Reason says why a config was written to, and it is the finding's whole
// content. Every one of them is a different thing to do about it, which is the
// same rule the fault kinds are closed by.
type Reason string

const (
	// ReasonNoLimit: the panel is enforcing nothing where we have allocated
	// something. Zero read off a panel means "no limit" (`RemoteClient`), so
	// this is the money hole in its plainest form.
	ReasonNoLimit Reason = "no_limit_on_panel"
	// ReasonAboveAllocation: the panel's ceiling is higher than the one we
	// allocated. ADR-0072 rule 2 — overwritten immediately, and past the
	// anti-flap stop (F-027-ab): it is never held and never counted.
	ReasonAboveAllocation Reason = "above_allocation"
	// ReasonBelowAllocation: the panel's ceiling is lower than ours. It costs
	// no money — it shortens the user's service — so it is rewritten and
	// reported rather than treated as an emergency.
	ReasonBelowAllocation Reason = "below_allocation"
	// ReasonCounterReset: this pass saw the counter go backward, so the figure
	// the panel needs today is not the figure it was given. This is the reason
	// the row exists: without the rewrite, the reset button is a way around
	// the guarantee.
	ReasonCounterReset Reason = "counter_reset"
	// ReasonExhausted: the allowance is spent, so the ceiling is zero. A panel
	// reports zero as "no limit" and cannot confirm it back, so this is
	// rewritten every pass and never counted as converged; cutting the user
	// off for real is the Grant suspension (F-027-x) and `desiredEnabled`
	// (F-027-z), not this number.
	ReasonExhausted Reason = "allowance_exhausted"
	// ReasonRefused: the panel would not take the ceiling. Nothing is recorded
	// as applied — the whole point of reading it back.
	ReasonRefused Reason = "write_refused"
	// ReasonContested: the panel's ceiling is lower than ours, somebody else
	// put it there, and the config's repair budget is spent (F-027-ab).
	// Nothing is written: a lower ceiling only shortens the user's service.
	ReasonContested Reason = "contested"
)

// Allocation is one config's share as the allocator left it, plus the panel's
// own id for the client that carries it.
type Allocation struct {
	ConfigID string
	// RemoteID is `config.remoteId`. Empty means the config has never been
	// created at the far end; there is nothing to write to, and filling it is
	// provisioning's (F-027-z).
	RemoteID string
	// AllocatedBytes is `config.allocatedCeilingBytes`, in **lifetime bytes
	// for this config** — the basis `purchasedBytes` is counted on, not the
	// panel's counter.
	AllocatedBytes int64
	// AppliedBytes is `config.appliedCeilingBytes`, in the same basis: what the
	// panel last confirmed. Nil where no read ever has. It is what tells a
	// ceiling somebody else wrote from one that is merely ours and stale.
	AppliedBytes *int64
	// WrittenBytes is `config.writtenCeilingBytes`, in the same basis: the
	// last figure this loop wrote and the panel accepted. Nil where we never
	// have. A panel holding it holds ours, whatever it last confirmed
	// (F-027-cu): a lowering written one pass and raised the next is read
	// back as this, never as the older confirmed figure.
	WrittenBytes *int64
	// RateBps is `config.observedRateBps`, what the guard band is sized on
	// (F-027-co). Zero where no rate was ever measured.
	RateBps int64
}

// AppliedCeiling is what a panel was found to be enforcing, expressed in the
// allocation's basis so that the gap to `allocatedCeilingBytes` is the loop's
// remaining work and nothing has to be translated to read it.
type AppliedCeiling struct {
	ConfigID string
	Bytes    int64
	At       time.Time
}

// WrittenCeiling is a figure this loop wrote and the panel accepted, in the
// allocation's basis. It is never a confirmation — that is AppliedCeiling,
// read back — only what tells our own figure from somebody else's (F-027-cu).
type WrittenCeiling struct {
	ConfigID string
	Bytes    int64
}

// Allocations is where the shares come from and where the confirmations go —
// `network.config` behind an interface, so the loop is proved against scripted
// panels the way the collection loop is.
type Allocations interface {
	For(ctx context.Context, panelID string) ([]Allocation, error)
	Record(ctx context.Context, rows []AppliedCeiling) error
	Wrote(ctx context.Context, rows []WrittenCeiling) error
}

// Finding is one config the pass did something about. A config whose panel
// already enforces the right figure produces none.
type Finding struct {
	ConfigID string
	RemoteID string
	Reason   Reason
	// WantBytes and HaveBytes are in the **panel's** basis: what we wrote, and
	// what the panel said it was enforcing when we looked.
	WantBytes int64
	HaveBytes int64
	// Err is set on ReasonRefused and is always a *driver.Fault.
	Err error
	// Overridden says the panel's ceiling is neither the one it last confirmed
	// nor the last one we wrote: somebody else wrote it (`limit_overridden`,
	// F-027-aa, F-027-cu). A top-up leaves the panel on a figure of ours, stale.
	Overridden bool
}

// Report is one panel's convergence, for the log line and the drift surface
// (F-027-ac). Checked counts allocations considered, so a panel with none is
// visibly a panel with none rather than a panel that passed.
type Report struct {
	PanelID  string
	Checked  int
	Synced   int
	Written  int
	Skipped  int
	Failed   int
	Findings []Finding
}

// Ceilings converges one panel's ceilings per call. It holds no state of its
// own: everything it knows comes from the allocations, the cursors and the
// panel itself.
type Ceilings struct {
	Allocations Allocations
	Counters    Counters
	Log         *slog.Logger
}

// Converge satisfies `collect.PassConverger`, so the ceilings are carried on
// the same pass that read the counters. That is not a convenience: the reset
// is detected in that pass and the ceiling it invalidates has to be rewritten
// before the next interval of traffic runs under it.
func (c *Ceilings) Converge(ctx context.Context, p collect.Panel, res collect.Result) error {
	report, err := c.Pass(ctx, p, res)
	if err != nil {
		return err
	}
	if report.Written > 0 || report.Failed > 0 {
		c.log().Info("ceilings converged",
			"panel", report.PanelID, "checked", report.Checked,
			"written", report.Written, "failed", report.Failed)
	}
	return nil
}

// Pass converges every allocated config on one panel: one read of what the
// panel is enforcing, then one write per config that disagrees.
//
// It returns an error only where the panel could not be read at all. A config
// the panel refuses is a finding, because one client must not stop the other
// five thousand being enforced.
func (c *Ceilings) Pass(ctx context.Context, p collect.Panel, res collect.Result) (Report, error) {
	return c.pass(ctx, p, res, nil, nil)
}

// PassOver is Pass over a population someone else already read — the
// `Converger`'s, which reads it once for provisioning and ceilings together
// (F-027-z), because a second `ListClients` per pass would be a second request
// against the same budget for the same answer (invariant 34). Stopped is
// provisioning's: the configs whose repair budget is spent, with the verdict
// each holds (F-027-ab).
func (c *Ceilings) PassOver(
	ctx context.Context, p collect.Panel, res collect.Result, clients []driver.RemoteClient, stopped map[string]DriftState,
) (Report, error) {
	if clients == nil {
		clients = []driver.RemoteClient{}
	}
	return c.pass(ctx, p, res, clients, stopped)
}

// pass reads the population only when it was not handed one, and only when
// there is an allocation to compare it against.
func (c *Ceilings) pass(
	ctx context.Context, p collect.Panel, res collect.Result, clients []driver.RemoteClient, stopped map[string]DriftState,
) (Report, error) {
	report := Report{PanelID: p.ID}

	allocations, err := c.Allocations.For(ctx, p.ID)
	if err != nil {
		return report, err
	}
	if len(allocations) == 0 {
		return report, nil
	}

	if clients == nil {
		// One request for the whole population, exactly as the bulk usage read
		// is (catalog 8.4): 5000 clients read one at a time is a flood on a
		// machine we do not own.
		clients, err = p.Driver.ListClients(ctx)
		if err != nil {
			return report, err
		}
	}
	enforcing := make(map[string]driver.RemoteClient, len(clients))
	for _, client := range clients {
		enforcing[client.RemoteID] = client
	}

	var confirmed []AppliedCeiling
	var written []WrittenCeiling
	var writes []pendingWrite
	for _, allocation := range allocations {
		report.Checked++
		client, onPanel := enforcing[allocation.RemoteID]
		if allocation.RemoteID == "" || !onPanel {
			// Nothing to write to. Whether that is a client we never created
			// or one that was renamed away from us is the drift comparison's
			// verdict to give (F-027-aa), not this pass's.
			report.Skipped++
			continue
		}

		offset := OffsetBytes(c.Counters, p, allocation.RemoteID)
		served := ServedBytes(c.Counters, p, allocation.RemoteID)
		// The planner's figure is the cut itself: its budget already holds
		// the panel's lag (`contract.lease.md` rule 19), so no band comes
		// off it here.
		want := PanelCeiling(allocation.AllocatedBytes, offset)
		have := client.DataLimitBytes

		if have > 0 {
			// The panel confirmed a ceiling. Zero is not a confirmation of
			// anything — a panel reports it for "no limit" — so it is never
			// recorded as one.
			confirmed = append(confirmed, AppliedCeiling{
				ConfigID: allocation.ConfigID,
				Bytes:    have + offset,
				At:       res.ObservedAt,
			})
		}

		if have == want && want > 0 {
			report.Synced++
			continue
		}

		reason := c.reason(p, allocation.RemoteID, res, want, have)
		overridden := overridden(reason, allocation, have, offset)
		if held(stopped, allocation.ConfigID, overridden, want, have) {
			report.Skipped++
			report.Findings = append(report.Findings, Finding{
				ConfigID: allocation.ConfigID, RemoteID: allocation.RemoteID,
				Reason: ReasonContested, WantBytes: want, HaveBytes: have, Overridden: overridden,
			})
			continue
		}
		writes = append(writes, pendingWrite{
			allocation: allocation, reason: reason, overridden: overridden,
			want: want, have: have, offset: offset,
			seconds: secondsToCrossing(want, have, served-offset, allocation.RateBps),
		})
	}

	// Every write waits on the panel's budget, so the order is the order the
	// panels learn their figures in (F-027-ct). Shrinks go first (F-027-db):
	// the planner frees a shrunk share only once a panel confirms it, so a
	// shrink queued behind a grow holds the bag's next grow back a turn.
	sort.SliceStable(writes, func(i, j int) bool {
		if si, sj := writes[i].shrinks(), writes[j].shrinks(); si != sj {
			return si
		}
		return writes[i].seconds < writes[j].seconds
	})
	for _, w := range writes {
		if err := p.Driver.SetClientDataLimit(ctx, w.allocation.RemoteID, w.want); err != nil {
			report.Failed++
			report.Findings = append(report.Findings, Finding{
				ConfigID: w.allocation.ConfigID, RemoteID: w.allocation.RemoteID,
				Reason: ReasonRefused, WantBytes: w.want, HaveBytes: w.have, Err: err, Overridden: w.overridden,
			})
			continue
		}
		report.Written++
		written = append(written, WrittenCeiling{ConfigID: w.allocation.ConfigID, Bytes: w.want + w.offset})
		report.Findings = append(report.Findings, Finding{
			ConfigID: w.allocation.ConfigID, RemoteID: w.allocation.RemoteID,
			Reason: w.reason, WantBytes: w.want, HaveBytes: w.have, Overridden: w.overridden,
		})
	}

	if len(confirmed) > 0 {
		if err := c.Allocations.Record(ctx, confirmed); err != nil {
			return report, err
		}
	}
	if len(written) > 0 {
		if err := c.Allocations.Wrote(ctx, written); err != nil {
			return report, err
		}
	}
	return report, nil
}

// pendingWrite is one decided write, held until the pass knows every write it
// owes and can order them.
type pendingWrite struct {
	allocation Allocation
	reason     Reason
	overridden bool
	want, have int64
	offset     int64
	seconds    float64
}

// shrinks: the panel holds a ceiling and ours is lower.
func (w pendingWrite) shrinks() bool { return w.have > 0 && w.want < w.have }

// secondsToCrossing is how long, at its own rate, a config has before it
// crosses the figure that matters (F-027-ct): the ceiling the panel holds
// where ours is higher, because the panel cuts there first, and ours where it
// is lower or the panel holds none, because past it is traffic nobody bought.
// All in the panel's basis. Already past it is negative, and first; a config
// with no measured rate crosses nothing and goes last — an idle shrink costs
// no money and no service while it waits.
func secondsToCrossing(want, have, counter, rateBps int64) float64 {
	if rateBps <= 0 {
		return math.Inf(1)
	}
	crossing := want
	if have > 0 && have < want {
		crossing = have
	}
	return float64(crossing-counter) * 8 / float64(rateBps)
}

// reason names what this write is about. The order is the order of how much
// the answer tells someone reading it: an exhausted allowance explains itself,
// a reset explains a figure that was right an interval ago, and the two drift
// directions explain a number somebody else wrote.
func (c *Ceilings) reason(p collect.Panel, remoteID string, res collect.Result, want, have int64) Reason {
	switch {
	case want == 0:
		return ReasonExhausted
	case c.sawReset(p, remoteID, res):
		return ReasonCounterReset
	case have == 0:
		return ReasonNoLimit
	case have > want:
		return ReasonAboveAllocation
	default:
		return ReasonBelowAllocation
	}
}

// overridden asks whether the ceiling being corrected is somebody else's. Only
// a drift reason can be: an exhausted allowance and a reset are ours to
// explain. With no confirmed figure to compare against, nothing is blamed, and
// a figure we wrote is ours even before a read confirms it (F-027-cu).
func overridden(reason Reason, allocation Allocation, have, offset int64) bool {
	switch reason {
	case ReasonNoLimit, ReasonAboveAllocation, ReasonBelowAllocation:
		return allocation.AppliedBytes != nil && have+offset != *allocation.AppliedBytes &&
			(allocation.WrittenBytes == nil || have+offset != *allocation.WrittenBytes)
	}
	return false
}

// held asks whether the anti-flap stop holds this write. It only ever holds a
// raise of a finite ceiling — every lowering is the exception, and so is a
// client with none — and only one somebody else caused: overridden now, or
// already contested, because once the held figure has been read back it is
// the panel's confirmed one and no longer looks foreign. Our own top-up over
// our own stale figure is never held.
func held(stopped map[string]DriftState, configID string, overridden bool, want, have int64) bool {
	was, ok := stopped[configID]
	return ok && have > 0 && want > have && (overridden || was == DriftContested)
}

// sawReset asks whether **this** pass is the one that found the counter going
// backward. It reads the cursor's own reset mark rather than the delta stream,
// because a counter zeroed between two reads publishes no delta at all — the
// post-reset figure can be zero — and that is exactly the case the rewrite
// exists for.
func (c *Ceilings) sawReset(p collect.Panel, remoteID string, res collect.Result) bool {
	counter, seen := c.Counters.Counter(p.ID, remoteID)
	return seen && !counter.LastResetAt.IsZero() && counter.LastResetAt.Equal(res.ObservedAt)
}

// OffsetBytes is what the panel's counter no longer holds: the lifetime bytes
// this config has served, less what the panel is reporting now. It is the
// whole of the translation, and it is never negative — see the package
// comment on why unbilled bytes on the far end's counter get no headroom.
//
// It is exported because the graceful-shutdown extension (F-027-w) raises the
// same ceiling on the same panel and therefore needs the same origin. Written
// twice, the two would drift, and the drift would only be visible as a wrong
// limit on somebody else's server.
func OffsetBytes(counters Counters, p collect.Panel, remoteID string) int64 {
	counter, seen := counters.Counter(p.ID, remoteID)
	if !seen {
		return 0
	}
	lifetime := counter.LifetimeUpBytes + counter.LifetimeDownBytes
	offset := lifetime - panelCounterBytes(p.CounterSemantics, counter)
	if offset < 0 {
		return 0
	}
	return offset
}

// panelCounterBytes is what the far end's own counter reads now, which is not
// the same question as what the config has served.
//
//   - cumulative: the raw figure we just read off it.
//   - reset_on_read: zero — the act of reading spent it.
//   - session: User Manager's per-user total, which starts at the client's
//     create — `collect.SessionCounter`, our Σ less its baseline (F-027-du).
func panelCounterBytes(semantics driver.CounterSemantics, counter collect.Counter) int64 {
	if semantics == driver.CounterResetOnRead {
		return 0
	}
	return counter.LastUpBytes + counter.LastDownBytes
}

// PanelCeiling turns a lifetime allowance into the figure that panel's counter
// needs today. It cannot exceed the allowance, so `Σ ceilings ≤
// purchasedBytes` (entitlement invariant 8) survives the translation — and the
// shutdown extension's own, larger allowance (F-027-w) is bounded the same way
// by the money behind it.
func PanelCeiling(allowance, offset int64) int64 {
	ceiling := allowance - offset
	if ceiling < 0 {
		return 0
	}
	return ceiling
}

func (c *Ceilings) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}
	return slog.Default()
}

// FaultKindOf reports the driver's classification of a refused write, for a
// caller deciding between backing off and alerting the panel's owner
// (F-027-v). It is here so nothing above this package reads a status code.
func FaultKindOf(err error) (driver.FaultKind, bool) {
	var fault *driver.Fault
	if errors.As(err, &fault) {
		return fault.Kind, true
	}
	return "", false
}
