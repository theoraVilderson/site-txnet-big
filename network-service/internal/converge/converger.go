package converge

import (
	"context"
	"log/slog"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
)

// ConvergeReport is one panel's whole convergence.
type ConvergeReport struct {
	Provisioning ProvisionReport
	Ceilings     Report
}

// Converger is the pass's converger: one read of the panel's clients, then
// provisioning, then ceilings over the same read. It satisfies
// `collect.PassConverger` in place of `Ceilings`.
//
// Provisioning goes first because a disable or a delete changes what a
// ceiling means; the clients it deleted are taken out of the ceiling pass's
// population, so a stale share is never written to a client that is gone.
//
// Confirm, when set, is asked for a read of the panel after a pass that wrote
// to it (`collect.Waker.Confirm`, F-111-n): the write is `partial` until a
// read finds it, and the Grant it serves activates only then. A confirming
// turn never asks again, so a panel that does not hold what we write costs
// one extra read, and then the minute pass as before.
type Converger struct {
	Provisioning *Provisioning
	Ceilings     *Ceilings
	Confirm      func(ctx context.Context, panelID string)
	// Owe, when set, is asked for another convergence turn on a panel whose
	// turn deferred creates (`collect.Waker.Wake`, F-027-fj): the backlog is
	// carried by woken turns, never by the bulk pass.
	Owe func(ctx context.Context, panelID string)
	Log *slog.Logger
}

func (c *Converger) Converge(ctx context.Context, p collect.Panel, res collect.Result) error {
	report, err := c.Pass(ctx, p, res)
	if err != nil {
		return err
	}
	prov, ceil := report.Provisioning, report.Ceilings
	if prov.Written > 0 || prov.Failed > 0 || prov.Captured > 0 || ceil.Written > 0 || ceil.Failed > 0 || len(prov.Orphans) > 0 || prov.Deferred > 0 {
		c.log().Info("panel converged",
			"panel", p.ID, "provisioned", prov.Written, "provision_failed", prov.Failed, "links_captured", prov.Captured, "links_refreshed", prov.Refreshed,
			"ceilings_written", ceil.Written, "ceilings_failed", ceil.Failed, "orphans", len(prov.Orphans), "deferred", prov.Deferred, "stalled", prov.Stalled)
	}
	if prov.Deferred > 0 && !prov.Stalled && c.Owe != nil {
		c.Owe(ctx, p.ID)
	}
	if prov.Written > 0 && !res.Confirming && c.Confirm != nil {
		c.Confirm(ctx, p.ID)
	}
	return nil
}

// Pass returns an error only where the panel could not be read or the rows
// could not be recorded.
func (c *Converger) Pass(ctx context.Context, p collect.Panel, res collect.Result) (report ConvergeReport, err error) {
	clients, err := p.Driver.ListClients(ctx)
	if err != nil {
		return report, err
	}
	clients = p.Anchor.Without(clients) // never an orphan, a seat or converged (F-027-ew)
	if c.Provisioning != nil {
		// A foreign claim returns ErrForeignClaim: no ceiling is written and
		// no verdict recorded over another server's clients (F-027-cf).
		report.Provisioning, err = c.Provisioning.PassOver(ctx, p, clients, res.ObservedAt)
		if err != nil {
			return report, err
		}
		defer func() {
			if err == nil {
				err = c.recordDrift(ctx, report, res.ObservedAt)
			}
		}()
	}
	if c.Ceilings != nil {
		remaining := clients
		if len(report.Provisioning.Removed) > 0 {
			remaining = make([]driver.RemoteClient, 0, len(clients))
			for _, client := range clients {
				if !report.Provisioning.Removed[client.RemoteID] {
					remaining = append(remaining, client)
				}
			}
		}
		report.Ceilings, err = c.Ceilings.PassOver(ctx, p, res, remaining, report.Provisioning.Stopped)
	}
	return report, err
}

// recordDrift completes provisioning's identity verdicts with the ceiling
// pass's and writes the ones that changed, and every repair (F-027-aa,
// F-027-ab).
func (c *Converger) recordDrift(ctx context.Context, report ConvergeReport, at time.Time) error {
	judge(report.Provisioning.Drift, report.Ceilings)
	rows := changed(report.Provisioning.Drift, at)
	if len(rows) == 0 {
		return nil
	}
	return c.Provisioning.Desired.RecordDrift(ctx, rows)
}

func (c *Converger) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}
	return slog.Default()
}
