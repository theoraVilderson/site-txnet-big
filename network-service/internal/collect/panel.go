package collect

import (
	"network-service/internal/anchor"
	"network-service/internal/driver"
)

// Panel is one panel as a pass needs it: its declaration, its driver, and who
// its remote clients belong to.
type Panel struct {
	ID string
	// Host is where it is dialled — its API address's host, empty for a push
	// panel. Only the reach gate's mass rule reads it (ADR-0122).
	Host string
	// CounterSemantics and Transport are the declaration (ADR-0074). They
	// select the arithmetic below, and a panel re-declared invalidates every
	// cursor computed under the old one.
	CounterSemantics driver.CounterSemantics
	Transport        driver.Transport
	// DriverType is the family, carried for its enforcement lag — how long
	// the panel serves past a ceiling (F-027-co, the guard band).
	DriverType driver.DriverType
	// The panel's own enforcement lag as the lease planner measured it
	// (F-027-cz): `lagMeanSec`, `lagVarianceSec2` over `lagSamples`
	// crossings, zero with none. EnforcementLag prefers it to the family's.
	LagMeanSec, LagVarianceSec2 float64
	LagSamples                  int
	// MaxLineRateBps is `panel.maxLineRateBps`, the ceiling on what the far
	// end could physically have carried. The column is nullable, so zero is
	// **unknown**, not zero: a panel that has not declared a line rate gets no
	// rate cap rather than a cap of nothing, because the second reading
	// quarantines every byte on it in silence.
	MaxLineRateBps int64
	// MaxRequestsPerMinute is `panel.maxRequestsPerMinute`, the budget we hold
	// ourselves to on somebody else's server. It is carried on the row rather
	// than fixed in the loop because it is the panel owner's figure, and
	// `Paced` is what turns it into behaviour (F-027-v, invariant 34).
	MaxRequestsPerMinute int
	// RateLimitable is the panel's `per_client_rate_limit` answer in its
	// capability document. Only such a panel is sent a speed cap (F-311-p);
	// elsewhere a cap is recorded and not enforced, never a write the family
	// refuses every pass.
	RateLimitable bool
	// IPLimitable is its `per_client_ip_limit` answer: only such a panel is
	// sent a Grant's device limit (F-311-q), as RateLimitable is for a cap.
	IPLimitable bool
	Driver      driver.Driver
	// ReviewState is `panel.reviewState`. Only an accepted panel is read or
	// converged (F-027-aq): a pending one has not answered the questionnaire
	// and a refused one failed it, so neither has users to meter.
	ReviewState driver.ReviewState
	// OwnershipType is `panel.ownershipType` and TenantID its `tenantId`, set
	// exactly when the ownership is `tenant` (invariant 9). They are carried
	// through the pass rather than joined for by the consumer, because the
	// bandwidth a panel served is a cost its owner pays (F-1002) and the
	// collector is already holding the row that says who that is.
	OwnershipType string
	TenantID      string
	// Configs maps the panel's own client id to the config that owns it, read
	// off `config.remoteId`. The convergence pass's three-key match (F-027-aa)
	// re-keys a renamed or rebuilt client's row, so the pass after it claims
	// the reading again; until then it is an Unattributed row, never nothing.
	Configs map[string]ConfigRef
	// Anchor is `panel.anchor*` (F-027-ew): the client the panel is known by,
	// never a user. Zero is a panel that carries none yet.
	Anchor anchor.Anchor
	// Address holds a panel registered by a name to the addresses it was
	// accepted at (F-027-ez).
	Address Address
}
