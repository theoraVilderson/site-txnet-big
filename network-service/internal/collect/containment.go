package collect

import (
	"context"
	"errors"
	"fmt"
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

// DriftEventType is `network.PanelDriftEventType`. MassReset is raised here;
// ForeignClaim by the convergence pass, the one that reads the panel's
// clients, and by the anchor check, as IdentityLost is. The other mass_*
// values are schema only.
type DriftEventType string

const (
	MassReset DriftEventType = "mass_reset"
	// ForeignClaim is a panel answering with another panel's clients (F-027-cf,
	// ADR-0090 decision 1): its address was re-pointed after registration.
	ForeignClaim DriftEventType = "foreign_claim"
	// IdentityLost is a panel answering with neither its own anchor nor
	// another panel's (F-027-ex, ADR-0130 decision 2): re-pointed to a server
	// we do not know, or the same one reinstalled. Only a person can say which.
	IdentityLost DriftEventType = "identity_lost"
	// AddressMoved is a panel's name resolving to none of the addresses it
	// was accepted at (F-027-ez, ADR-0130 decision 4): its login is not sent.
	AddressMoved DriftEventType = "address_moved"
)

// Converges says whether a panel halted by this event is still converged. A
// restore's counters are not believed, but the server is ours, so a
// suspension or a delete still has to reach it. A foreign claim is the
// opposite: the server is not the one our configs are on, and converging it
// would recreate them there. A lost identity is not known to be ours, and a
// moved address is not one we may send the login to.
func (t DriftEventType) Converges() bool {
	return t != ForeignClaim && t != IdentityLost && t != AddressMoved
}

// The defaults the stop fires at (user, 2026-09-23): **more than** 20% of the
// panel's cumulative counters going backward in one pass, and at least five
// of them. The floor is what keeps a three-client panel with one reset from
// halting; halting when unsure is the safe direction, because nothing is lost
// by it — the bytes are parked and the ceilings are still enforced.
//
// Below the floor, every counter going backward together is still a restore
// (F-027-fd, ADR-0130 decision 5): the floor alone let a panel with few of
// our clients be charged its restored figures twice. One counter alone is a
// reset, so it takes at least MassResetAllMinimum.
const (
	DefaultMassResetPercent = 20
	DefaultMassResetFloor   = 5
	MassResetAllMinimum     = 2
)

// OpHalted is the `Op` of a panel whose collection is halted, so a halted
// panel is a row in the report — and ages into the watchdog's alert, because
// its turn is never stamped — rather than a silent absence.
const OpHalted = "halted"

var ErrCollectionHalted = errors.New("panel collection is halted by a drift event; not read until it is acknowledged")

// DriftEvent is one `panel_drift_event` row. Both counts, never the ratio: a
// percentage cannot be checked afterwards (invariant 23).
type DriftEvent struct {
	PanelID string
	Type    DriftEventType
	// ForeignPanelID is the panel whose clients a ForeignClaim found, and set
	// on no other type (`panel_drift_event_foreign_is_claim`).
	ForeignPanelID string
	// KnownAddresses and SeenAddresses are what an AddressMoved panel was
	// accepted at and what its name answered; set on no other type
	// (`panel_drift_event_addresses_are_a_move`).
	KnownAddresses   []string
	SeenAddresses    []string
	Affected         int
	Observed         int
	DetectedAt       time.Time
	CollectionHalted bool
	AcknowledgedAt   time.Time
}

// DriftEvents is where the events go and whether one still halts a panel.
// Halted answers the type of the open event that halts it, "" for none; of
// several, one that stops convergence too (DriftEventType.Converges).
type DriftEvents interface {
	Halted(ctx context.Context, panelID string) (DriftEventType, error)
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
func (c *Containment) Halted(ctx context.Context, panelID string) (DriftEventType, error) {
	if c == nil || c.Events == nil {
		return "", nil
	}
	return c.Events.Halted(ctx, panelID)
}

// Raise writes an event raised outside Contain — the anchor check's. No store
// fails closed: an event that cannot be written must not let the turn read on.
func (c *Containment) Raise(ctx context.Context, event DriftEvent) error {
	if c == nil || c.Events == nil {
		return fmt.Errorf("panel %s: no drift event store to raise %s in", event.PanelID, event.Type)
	}
	return c.Events.Raise(ctx, event)
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
	if !c.isMassReset(affected, observed) {
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

// isMassReset is the threshold: past the floor and the share, or every
// counter read (at least MassResetAllMinimum) at once.
func (c *Containment) isMassReset(affected, observed int) bool {
	if affected >= MassResetAllMinimum && affected == observed {
		return true
	}
	return affected >= c.floor() && affected*100 > c.percent()*observed
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

func (m *MemoryDriftEvents) Halted(_ context.Context, panelID string) (DriftEventType, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var halt DriftEventType
	for _, e := range m.byPanel[panelID] {
		if e.CollectionHalted && e.AcknowledgedAt.IsZero() && (halt == "" || !e.Type.Converges()) {
			halt = e.Type
		}
	}
	return halt, nil
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

// PostgresDriftEvents is DriftEvents over `network.panel_drift_event`. An
// event halts until an admin acknowledges it, and nothing here acknowledges.
type PostgresDriftEvents struct {
	DB DB
}

var _ DriftEvents = PostgresDriftEvents{}

// haltedSQL is the type of the open event that halts the panel, one that
// stops convergence too first (DriftEventType.Converges).
const haltedSQL = `
SELECT "eventType"::text FROM network.panel_drift_event
 WHERE "panelId" = $1::uuid AND "collectionHalted" AND "acknowledgedAt" IS NULL
 ORDER BY ("eventType" IN ('foreign_claim', 'identity_lost', 'address_moved')) DESC
 LIMIT 1`

func (s PostgresDriftEvents) Halted(ctx context.Context, panelID string) (DriftEventType, error) {
	rows, err := s.DB.Query(ctx, haltedSQL, panelID)
	if err != nil {
		return "", fmt.Errorf("reading panel %s drift events: %w", panelID, err)
	}
	defer rows.Close()
	var halt string
	if rows.Next() {
		if err := rows.Scan(&halt); err != nil {
			return "", fmt.Errorf("reading panel %s drift events: %w", panelID, err)
		}
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("reading panel %s drift events: %w", panelID, err)
	}
	return DriftEventType(halt), nil
}

// DriftRaisedEvent is the outbox type a halting event is announced under
// (F-027-fg, ADR-0130 decision 5): worker-service pushes it on the owner's
// `tenant:` channel, so an open systems page re-reads, and tells the owner
// which panel stopped and why. Declared in contracts/realtime/events.json.
const DriftRaisedEvent = "network.panel.drift_raised"

// raiseSQL writes the event and, when it halts, its announcement in one
// statement, so they commit or fail together (ADR-0021). The owner is the
// panel's tenant, or the platform_owner's for a platform panel (invariant 9),
// named as `network.panel.state_changed` names it. A non-halting event is the
// report's alone: nobody waits on it.
const raiseSQL = `
WITH raised AS (
  INSERT INTO network.panel_drift_event
         (id, "panelId", "eventType", "foreignPanelId", "affectedConfigCount", "observedConfigCount", "detectedAt", "collectionHalted",
          "knownAddresses", "seenAddresses")
  VALUES (gen_random_uuid(), $1::uuid, $2::network."PanelDriftEventType", $3::uuid, $4, $5, $6, $7, $8::text[], $9::text[])
  RETURNING id, "panelId", "eventType", "collectionHalted"
)
INSERT INTO automation.outbox_event (id, aggregate, "aggregateId", type, payload)
SELECT gen_random_uuid(), 'network.panel', p.id::text, $10::text,
       jsonb_build_object(
         'panelId', p.id::text,
         'panelName', p.name,
         'tenantId', o.id::text,
         'ownerUserId', o."ownerUserId"::text,
         'driftEventId', r.id::text,
         'eventType', r."eventType"::text)
  FROM raised r
  JOIN network.panel p ON p.id = r."panelId"
  LEFT JOIN LATERAL (
    SELECT o.id, o."ownerUserId" FROM tenant.tenant o
     WHERE o.id = p."tenantId"
        OR (p."tenantId" IS NULL AND o."tenantType" = 'platform_owner')
     ORDER BY o."createdAt", o.id LIMIT 1) o ON true
 WHERE r."collectionHalted"`

func (s PostgresDriftEvents) Raise(ctx context.Context, e DriftEvent) error {
	var foreign *string
	if e.ForeignPanelID != "" {
		foreign = &e.ForeignPanelID
	}
	if _, err := s.DB.Exec(ctx, raiseSQL, e.PanelID, string(e.Type), foreign, e.Affected, e.Observed, e.DetectedAt, e.CollectionHalted,
		e.KnownAddresses, e.SeenAddresses, DriftRaisedEvent); err != nil {
		return fmt.Errorf("raising panel %s drift event: %w", e.PanelID, err)
	}
	return nil
}
