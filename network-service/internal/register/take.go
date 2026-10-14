package register

import (
	"context"
	"fmt"
	"time"

	"network-service/internal/anchor"
	"network-service/internal/driver"
)

// registrationLock is the advisory lock Serialised holds (ADR-0130 decision 3).
const registrationLock = "network.panel.registration"

// take is the end of a test for a pull panel the questionnaire would take,
// run under Serialised: whether it is one already registered (F-027-ce), then
// its anchor (F-027-ew), then the verdict that records both. Inside the lock,
// a second registration of the same server sees the first one's verdict.
func (r *Registrar) take(
	ctx context.Context, d driver.Driver, p Pending, caps driver.Capabilities, verdict driver.Verdict,
	at time.Time, report *Report, fail func(FaultKind, string) error,
) error {
	checkCtx, cancel := context.WithTimeout(ctx, orDefault(r.Timeout, DefaultTimeout))
	defer cancel()
	holder, found, err := r.duplicateOf(checkCtx, d, p)
	if err == nil && found {
		return r.duplicate(ctx, p, caps, holder, at, report)
	}
	var planted bool
	if err == nil {
		p.Anchor, planted, err = r.anchorOn(checkCtx, d, p)
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fail(faultOf(err, FaultKind(driver.FaultProtocol)), err.Error())
	}

	written, err := r.answer(ctx, p, caps, verdict, at, report)
	if planted && !written {
		// Withdrawn or edited while it was tested, or the write failed: the
		// row does not name this anchor, so it would be an orphan of ours.
		r.takeBack(ctx, d, p.PanelID, p.Anchor)
	}
	return err
}

// duplicate refuses p as holder's duplicate.
func (r *Registrar) duplicate(ctx context.Context, p Pending, caps driver.Capabilities, holder Holder, at time.Time, report *Report) error {
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

// anchorOn is the anchor the panel will be recorded with: the one it already
// carries, if it is on this server, else a new one, planted (true). A re-test
// after an address edit must not leave two.
func (r *Registrar) anchorOn(ctx context.Context, d driver.Driver, p Pending) (anchor.Anchor, bool, error) {
	if p.Anchor.Planted() {
		clients, err := d.ListClients(ctx)
		if err != nil {
			return anchor.Anchor{}, false, fmt.Errorf("anchor: listing clients: %w", err)
		}
		if c, ok := p.Anchor.In(clients); ok {
			kept := p.Anchor
			kept.RemoteID = c.RemoteID
			return kept, false, nil
		}
	}
	a, err := anchor.Plant(ctx, d)
	if err != nil {
		return anchor.Anchor{}, false, fmt.Errorf("anchor: could not be planted: %w", err)
	}
	return a, true, nil
}

// takeBack deletes an anchor no row names, on a context the test's own
// deadline cannot cut, as the canary is.
func (r *Registrar) takeBack(ctx context.Context, d driver.Driver, panelID string, a anchor.Anchor) {
	delCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), canaryDeleteTimeout)
	defer cancel()
	if err := d.DeleteClient(delCtx, a.RemoteID); err != nil {
		r.log().Error("unrecorded anchor not deleted; it is disabled, remove it by hand",
			"panel", panelID, "remoteId", a.RemoteID, "tag", a.Tag, "error", err)
	}
}
