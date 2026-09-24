package driver

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// The invariant this file turns on (F-027-bf, ADR-0081): a page is a request.
// A family whose bulk read is paged spends the panel's budget once per page,
// not once per call — otherwise 5000 clients at 100 a page would be fifty
// requests on someone else's server that the budget counted as one.

// pagedPanel is a driver whose bulk read is `pages` requests, each stamped at
// the far end, the way a paged family's GetUsage is.
type pagedPanel struct {
	Driver // nil: only GetUsage is called

	pages int
	mu    sync.Mutex
	sent  []time.Time
}

func (p *pagedPanel) GetUsage(ctx context.Context) ([]ClientUsage, error) {
	for page := 0; page < p.pages; page++ {
		if page > 0 {
			if err := NextPage(ctx, "GetUsage"); err != nil {
				return nil, err
			}
		}
		p.mu.Lock()
		p.sent = append(p.sent, time.Now())
		p.mu.Unlock()
	}
	return nil, nil
}

// maxInWindow is the most requests the far end saw inside any one window.
func (p *pagedPanel) maxInWindow(window time.Duration) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	most := 0
	for i := range p.sent {
		n := 0
		for j := i; j < len(p.sent) && p.sent[j].Sub(p.sent[i]) < window; j++ {
			n++
		}
		if n > most {
			most = n
		}
	}
	return most
}

func TestPaceSpendsTheBudgetOncePerPage(t *testing.T) {
	const budget, pages = 4, 9
	window := 150 * time.Millisecond
	panel := &pagedPanel{pages: pages}
	d := Pace(panel, Budget{MaxRequests: budget, Window: window})

	start := time.Now()
	if _, err := d.GetUsage(context.Background()); err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	elapsed := time.Since(start)

	if got := len(panel.sent); got != pages {
		t.Fatalf("the far end saw %d requests, want %d pages", got, pages)
	}
	if most := panel.maxInWindow(window); most > budget {
		t.Errorf("%d requests reached the panel inside one window, budget %d: "+
			"the pages after the first were not paced", most, budget)
	}
	// Nine pages at four a window need a third window to start.
	if elapsed < 2*window {
		t.Errorf("nine pages at four a window took %v, want at least %v", elapsed, 2*window)
	}
}

func TestNextPageOutsidePaceIsFree(t *testing.T) {
	panel := &pagedPanel{pages: 50}
	if _, err := panel.GetUsage(context.Background()); err != nil {
		t.Fatalf("an unpaced paged read failed: %v", err)
	}
	if len(panel.sent) != 50 {
		t.Fatalf("the far end saw %d requests, want 50", len(panel.sent))
	}
}

func TestNextPageHonoursTheCallersDeadline(t *testing.T) {
	panel := &pagedPanel{pages: 3}
	d := Pace(panel, Budget{MaxRequests: 1, Window: time.Hour})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	_, err := d.GetUsage(ctx)
	var fault *Fault
	if !errors.As(err, &fault) || fault.Kind != FaultTimeout {
		t.Fatalf("a page that cannot fit the budget before the deadline returned %v, want a timeout fault", err)
	}
	if len(panel.sent) != 1 {
		t.Errorf("the far end saw %d requests, want only the first page", len(panel.sent))
	}
}
