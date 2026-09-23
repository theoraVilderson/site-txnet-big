package collect

import (
	"context"
	"errors"
	"sync"
	"time"

	"network-service/internal/driver"
)

// The panel-wide stop (F-027-ab). One counter going backward is a reset, and
// the normaliser bills the post-reset figure as real. A backup restore is
// every counter going backward at once, each one individually plausible, and
// billing them is the restored figures charged a second time — ~$16k of wrong
// charges in a minute on a busy panel. So the population is judged before the
// pass publishes, and a panel that looks restored stops being read until
// somebody decides it may be (`panel_drift_event.collectionHalted`).

// ReasonPanelDriftEvent parks a delta the panel-wide stop would not believe.
const ReasonPanelDriftEvent QuarantineReason = "panel_drift_event"

// DriftEventType is `network.PanelDriftEventType`. Only MassReset is raised
// here: the others are the convergence pass's population and are not built.
type DriftEventType string

const MassReset DriftEventType = "mass_reset"

// The defaults the stop fires at (user, 2026-09-23): **more than** 20% of the
// panel's cumulative counters going backward in one pass, and at least five
// of them. The floor is what keeps a three-client panel with one reset from
// halting; halting when unsure is the safe direction, because nothing is lost
// by it — the bytes are parked and the ceilings are still enforced.
const (
	DefaultMassResetPercent = 20
	DefaultMassResetFloor   = 5
)

// OpHalted is the `Op` of a panel whose collection is halted, so a halted
// panel is a row in the report — and ages into the watchdog's alert, because
// its turn is never stamped — rather than a silent absence.
const OpHalted = "halted"

var ErrCollectionHalted = errors.New("panel collection is halted by a drift event; not read until it is acknowledged")

// DriftEvent is one `panel_drift_event` row. Both counts, never the ratio: a
// percentage cannot be checked afterwards (invariant 23).
type DriftEvent struct {
	PanelID          string
	Type             DriftEventType
	Affected         int
	Observed         int
	DetectedAt       time.Time
	CollectionHalted bool
	AcknowledgedAt   time.Time
}

// DriftEvents is where the events go and whether one still halts a panel.
type DriftEvents interface {
	Halted(ctx context.Context, panelID string) (bool, error)
	Raise(ctx context.Context, event DriftEvent) error
}

// Containment is the stop. Nil, or nil Events, contains nothing, which is what
// every test of the normaliser wants.
type Containment struct {
	Events DriftEvents
	// Percent and Floor are the thresholds (DefaultMassReset*).
	Percent int
	Floor   int
}

// Halted asks whether the panel may be read. A store that cannot answer is an
// error, and the caller does not read: not knowing is not permission.
func (c *Containment) Halted(ctx context.Context, panelID string) (bool, error) {
	if c == nil || c.Events == nil {
		return false, nil
	}
	return c.Events.Halted(ctx, panelID)
}

// Contain judges one normalised pass before it is published. Past the
// threshold it raises the event and parks every post-reset delta in the pass
// under `panel_drift_event`, taking those bytes out of the lifetime the
// cursors will hold — a quarantined byte is not a served one, which is what
// keeps the ceiling restated over the restored counter honest.
//
// The event is raised before the publish. If the publish then fails, the
// cursors stay where they were and the same restore is judged again after the
// acknowledgement: a second event, never a charge.
func (c *Containment) Contain(ctx context.Context, res *Result) error {
	if c == nil || c.Events == nil {
		return nil
	}
	affected, observed := 0, 0
	for _, a := range res.Advances {
		// Only a cumulative counter can go backward: a session panel survives
		// a restore (its high-water marks) and reset_on_read has no memory.
		if a.Session != nil || a.Counter.Semantics != driver.CounterCumulative {
			continue
		}
		observed++
		if a.Counter.LastResetAt.Equal(res.ObservedAt) {
			affected++
		}
	}
	if affected < c.floor() || affected*100 <= c.percent()*observed {
		return nil
	}

	event := DriftEvent{
		PanelID: res.PanelID, Type: MassReset, Affected: affected, Observed: observed,
		DetectedAt: res.ObservedAt, CollectionHalted: true,
	}
	if err := c.Events.Raise(ctx, event); err != nil {
		return err
	}

	advances := make(map[string]int, len(res.Advances))
	for i, a := range res.Advances {
		if a.Session == nil {
			advances[a.RemoteID] = i
		}
	}
	kept := res.Deltas[:0]
	for _, d := range res.Deltas {
		if !d.AfterReset {
			kept = append(kept, d)
			continue
		}
		res.Quarantines = append(res.Quarantines, Quarantine{
			PanelID: d.PanelID, ConfigID: d.ConfigID, RemoteID: d.RemoteID,
			UpBytes: d.UpBytes, DownBytes: d.DownBytes, ObservedAt: d.ObservedAt,
			Reason: ReasonPanelDriftEvent,
		})
		if i, ok := advances[d.RemoteID]; ok {
			res.Advances[i].Counter.LifetimeUpBytes -= d.UpBytes
			res.Advances[i].Counter.LifetimeDownBytes -= d.DownBytes
		}
	}
	res.Deltas = kept
	return nil
}

func (c *Containment) percent() int {
	if c.Percent > 0 {
		return c.Percent
	}
	return DefaultMassResetPercent
}

func (c *Containment) floor() int {
	if c.Floor > 0 {
		return c.Floor
	}
	return DefaultMassResetFloor
}

// MemoryDriftEvents holds events in memory — the same staging as
// `MemoryCursors`, until `panel_drift_event` is written directly.
type MemoryDriftEvents struct {
	mu      sync.Mutex
	byPanel map[string][]DriftEvent
}

func NewMemoryDriftEvents() *MemoryDriftEvents {
	return &MemoryDriftEvents{byPanel: map[string][]DriftEvent{}}
}

func (m *MemoryDriftEvents) Raise(_ context.Context, event DriftEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.byPanel[event.PanelID] = append(m.byPanel[event.PanelID], event)
	return nil
}

func (m *MemoryDriftEvents) Halted(_ context.Context, panelID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range m.byPanel[panelID] {
		if e.CollectionHalted && e.AcknowledgedAt.IsZero() {
			return true, nil
		}
	}
	return false, nil
}

// Acknowledge is somebody deciding the panel may be read again (the drift
// report, F-027-ad). It acknowledges every open event on the panel.
func (m *MemoryDriftEvents) Acknowledge(panelID string, at time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, e := range m.byPanel[panelID] {
		if e.AcknowledgedAt.IsZero() {
			m.byPanel[panelID][i].AcknowledgedAt = at
		}
	}
}

// Events is every event raised on one panel, oldest first.
func (m *MemoryDriftEvents) Events(panelID string) []DriftEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]DriftEvent(nil), m.byPanel[panelID]...)
}
