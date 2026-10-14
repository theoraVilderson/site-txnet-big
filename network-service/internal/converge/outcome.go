package converge

import (
	"context"
	"time"
)

// Outcome is what the pass learned about one row. RemoteID is the value the
// row should now hold, empty to clear it. Links is nil unless this pass
// captured them; nil leaves the stored lines as they are.
//
// UUID, Enabled and Present are the desired state the outcome was judged
// against. An action that writes between the read and the record has changed
// what the verdict is about, so a store that can see the row as it is now
// drops the outcome rather than confirm a state nobody checked — the next
// pass judges the new one (F-027-bo).
type Outcome struct {
	ConfigID string
	RemoteID string
	State    EnforcementState
	At       time.Time
	Links    *CapturedLinks
	UUID     string
	Enabled  bool
	Present  bool
	// InboundRemoteID is where this pass found — or created — the client of a
	// row that names no inbound (DesiredConfig.InboundResolved). The store
	// writes it only over none: a row that names its inbound is never
	// rewritten by a read (F-027-ch). Empty writes nothing.
	InboundRemoteID string
	// SessionBaseline is set by a create: the SessionBytes its first ceiling
	// was sized past, which becomes the row's `sessionBaselineBytes`
	// (F-027-du). Nil leaves the row's as it is.
	SessionBaseline *int64
	// Confirmed is the read that found a present client holding its desired
	// state, where the row did not already say so (F-111-n): the panels' word
	// a pending Grant activates on (contract.groups.md rule 10), announced.
	Confirmed bool
	// Recreated is a `missing` client made again: it counts from zero on the
	// panel, so the store restarts the config's raw cursor with it. Left at the
	// old client's figure, the next pass reads it backward (F-027-fc).
	Recreated bool
}

// Desired is `network.config`'s desired state behind an interface, as
// `Allocations` is.
// RecordDrift is a method of its own rather than a field of Outcome because two
// passes supply the verdict: provisioning the identity ones, the ceiling pass
// `reset` and `limit_overridden` (F-027-aa). It writes the repair count with
// the verdict (F-027-ab).
type Desired interface {
	For(ctx context.Context, panelID string) ([]DesiredConfig, error)
	Record(ctx context.Context, rows []Outcome) error
	RecordDrift(ctx context.Context, rows []Verdict) error
}
