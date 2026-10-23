package collect

import (
	"context"
	"errors"
)

// pushTurn is a push panel's turn (F-027-du). Its bytes came as packets and
// the receiver billed them, so nothing is published or moved: the reading is
// the receiver's totals. The panel is asked only whether the API that carries
// the ceiling answers; one that does not is an outage, as a failed read is on
// a pull panel. Then the turn plans and converges exactly as a pull turn does.
func (l *Loop) pushTurn(ctx, panelCtx context.Context, p Panel, polled bool) (Result, string, error) {
	err := p.Driver.HealthCheck(panelCtx)
	l.observe(ctx, p.ID, err)
	if err != nil {
		if l.Planner != nil && ctx.Err() == nil {
			l.Planner.Failed(p.ID, l.now())
		}
		return Result{}, "HealthCheck", err
	}
	if l.Sessions == nil {
		return Result{}, "Sessions", errors.New("no session totals to plan a push panel on")
	}
	readings, err := l.Sessions.Totals(panelCtx, p.ID)
	if err != nil {
		return Result{}, "Sessions", err
	}
	res := Result{PanelID: p.ID, OwnershipType: p.OwnershipType, TenantID: p.TenantID, ObservedAt: l.now()}
	if owed := l.plan(ctx, p, readings, res.ObservedAt); !polled || owed {
		l.converge(ctx, p, res)
	}
	return res, "", nil
}
