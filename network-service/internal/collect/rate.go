// The rate a pass measured, and the panel row's request budget (F-027-v).
//
// Both are the same kind of thing: a figure that belongs to the panel row
// rather than to the arithmetic, carried into the loop at the one place a row
// becomes something the loop can use.

package collect

import (
	"context"
	"time"

	"network-service/internal/driver"
)

// Paced wraps a panel's driver in the request budget its own row declares —
// `panel.maxRequestsPerMinute`, through `driver.Pace` (invariant 34).
//
// It is the one place the column becomes behaviour. `Pace` is written once for
// all thirteen families and holds both properties from the first driver on;
// what was missing until this row is the wiring, and a loop that built its own
// budget out of a constant would hold every panel to a figure its owner never
// agreed to.
//
// It panics on a non-positive budget, exactly as `Pace` does: the column is
// CHECKed positive (invariant 12), so a zero here is the constraint having
// been bypassed rather than a panel to handle gently.
func Paced(p Panel) Panel {
	return Repaced(p, nil)
}

// Repaced is Paced for a driver reopened in place of prev: on the same budget
// it keeps prev's Pacer, so the requests already spent, a rate a 429 halved
// and an open breaker all survive the reopen (F-027-df). A reopen falls due
// every cool-off (DefaultReopenAfter), exactly when a halved rate matters. A
// changed budget is a new agreement and starts fresh.
func Repaced(p Panel, prev driver.Driver) Panel {
	if pc, ok := driver.PacerOf(prev); ok && pc.Budget().MaxRequests == p.MaxRequestsPerMinute {
		p.Driver = pc.Wrap(p.Driver)
		return p
	}
	p.Driver = driver.Pace(p.Driver, driver.Budget{MaxRequests: p.MaxRequestsPerMinute})
	return p
}

// RateSample is one config's measured rate — `config.observedRateBps`.
//
// It is in bits per second because everything the hot loop does with it is in
// seconds: membership, the interval, and the size of the next block
// (`contract.hot-loop.md`). A byte figure would have to be divided by a window
// again at every reader, and the window is only known here.
type RateSample struct {
	PanelID  string
	ConfigID string
	RemoteID string
	RateBps  int64
	// ObservedAt is the pass's clock — the end of the window the rate was
	// measured over, and the moment the figure describes.
	ObservedAt time.Time
}

// Rates is where measured rates are written (`config.observedRateBps`) —
// `PostgresRates` in a running process. Nil on a loop records nothing, which
// is what every test of the normaliser wants.
type Rates interface {
	Record(ctx context.Context, samples []RateSample) error
}

// ObservedRates measures each delta against the gap since that counter was
// last read.
//
// It is called **before** `Cursors.Apply`, because the cursor still holds the
// previous observation then and that is the start of the window. The window a
// rate means anything over is the one between two readings of the same
// counter, and nothing else in the pass knows it.
//
// Three readings produce no sample rather than a wrong one:
//
//   - a config with no cursor yet — the adopting pass has nothing to measure
//     from, and billing starts at the moment we started watching;
//   - a window of zero or less — a rate over no time is not a large rate;
//   - a delta that followed a reset — the bytes are real, but whatever ran
//     between the last reading and the reset is not in them, so a rate read
//     off it understates the line. An understated rate sizes a block the user
//     has already outrun (`contract.hot-loop.md`), so the last rate we did
//     measure is left standing instead.
func ObservedRates(cursors Cursors, res Result) []RateSample {
	if cursors == nil {
		return nil
	}
	var samples []RateSample
	for _, delta := range res.Deltas {
		if delta.AfterReset {
			continue
		}
		cur, seen := cursors.Counter(delta.PanelID, delta.RemoteID)
		if !seen {
			continue
		}
		window := delta.ObservedAt.Sub(cur.LastObservedAt)
		if window <= 0 {
			continue
		}
		bits := float64(delta.UpBytes+delta.DownBytes) * 8
		samples = append(samples, RateSample{
			PanelID:    delta.PanelID,
			ConfigID:   delta.ConfigID,
			RemoteID:   delta.RemoteID,
			RateBps:    int64(bits / window.Seconds()),
			ObservedAt: delta.ObservedAt,
		})
	}
	return samples
}
