package driver

import (
	"context"
	"time"
)

// Driver is the whole surface of one panel family (catalog 7.1). Everything
// above it — the collection loop, the ceiling allocator, the convergence loop
// — is written once against this interface and knows nothing about inbounds,
// UUIDs or session cookies.
//
// Three methods are not in the catalog's sketch and are load-bearing here:
//
//   - SetClientDataLimit is what makes ADR-0072 possible. The ceiling is the
//     enforcement point that survives our service being down, and a family
//     that cannot write one cannot sell metered service.
//   - SetClientRateLimit is layer-2's other half, where the panel has it.
//   - GetUsageFor is what the hot loop needs: a pass over the few configs near
//     their ceiling must not cost a pass over all 5000 (F-027-u).
//
// Every method takes a context and is expected to honour its deadline: the
// loop's budget is per panel, not per call, and a driver that blocks past its
// timeout spends another panel's turn.
//
// Every error a method returns is a *Fault (fault.go). A bare error tells the
// loop nothing it can act on, and the difference between a 429 and a 5xx is
// the difference between backing off and quarantining — so the classification
// is the driver's job, made here, and the conformance suite refuses a driver
// that skips it (F-027-j).
type Driver interface {
	// Capabilities answers the acceptance questionnaire by connection test.
	// It is the registration call, and it is re-run when a panel is upgraded
	// — the answers are observations, not settings.
	Capabilities(ctx context.Context) (Capabilities, error)
	// HealthCheck is the cheapest call that proves the credentials still work.
	HealthCheck(ctx context.Context) error

	ListInbounds(ctx context.Context) ([]Inbound, error)

	// ListClients returns every client the panel holds, with the ceiling,
	// rate and expiry it is actually enforcing — never what we last asked
	// for. It is the far-end half of two comparisons: the convergence loop's
	// applied-against-allocated (F-027-t) and the drift report's
	// three-key match (F-027-aa), and both are worthless read from our own
	// side of the write.
	ListClients(ctx context.Context) ([]RemoteClient, error)

	CreateClient(ctx context.Context, req CreateClientRequest) (RemoteClient, error)
	UpdateClient(ctx context.Context, req UpdateClientRequest) error
	SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error
	DeleteClient(ctx context.Context, remoteID string) error

	// SetClientDataLimit writes the panel's own per-user byte ceiling. Zero is
	// a real ceiling — no traffic — and not "unlimited": the distinction is
	// the difference between a cut-off user and a free one (ADR-0072).
	SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error
	// SetClientRateLimit writes a per-client bandwidth cap. Zero means no cap.
	SetClientRateLimit(ctx context.Context, remoteID string, rateBps int64) error

	// GetUsage returns every client on the panel in one call. It is the bulk
	// pass, and one call is the contract: catalog 8.4 forbids per-client reads
	// and F-027-k asserts the request count.
	GetUsage(ctx context.Context) ([]ClientUsage, error)
	// GetUsageFor returns the named clients. A driver whose family has no
	// subset endpoint answers RowUsageForNamedSubset with no and may serve
	// this from the bulk call; the loop reads the answer, not the shape of
	// the implementation.
	GetUsageFor(ctx context.Context, remoteIDs []string) ([]ClientUsage, error)
	// ResetUsage zeroes a client's counter. We do not use it in the collection
	// loop — a reset is detected, never caused — and it exists for an operator
	// action on a panel that supports it.
	ResetUsage(ctx context.Context, remoteID string) error

	BuildLink(ctx context.Context, client RemoteClient, inbound Inbound) (string, error)
	// SubscriptionURL returns the panel's own subscription URL. The second
	// result is false where the family serves none, and the link is built
	// from the inbound instead.
	SubscriptionURL(ctx context.Context, remoteID string) (string, bool)
	// ClientLinks returns every link line the panel gives this client, in the
	// panel's order and as the panel built them — never lines assembled here,
	// which would disagree with the ones the panel serves (ADR-0082 rule 2).
	// It is what the provisioning pass stores and `/sub` renders.
	//
	// A family, or a panel, that has no links to give answers no lines and
	// no error: that is a fact about the panel, not a failure, and the config
	// simply contributes nothing to `/sub`. A read that failed is a Fault,
	// never an empty answer, so a transient error cannot erase stored lines.
	ClientLinks(ctx context.Context, client RemoteClient) ([]string, error)
}

// Inbound is one listener on the panel: the thing a client's link points at.
type Inbound struct {
	// RemoteID is the panel's own identifier for the inbound.
	RemoteID string
	Tag      string
	// Protocol is the family's own spelling, normalised to the values of
	// `network.ConfigProtocol` by the driver, not by its caller.
	Protocol string
	Port     int
	Host     string
	Enabled  bool
}

// RemoteClient is one client as the panel holds it — never as we hold it. The
// config row is ours; this is what we found at the far end, which is the whole
// point of the drift comparison (F-027-aa).
type RemoteClient struct {
	// RemoteID is the panel's identifier, unique on that panel and the first
	// of the three matching keys.
	RemoteID string
	// Label is the field we store our claim tag in, where the family has one
	// (RowClientLabelStorable). It is the second matching key.
	Label string
	// UUID is the Xray identity, and the third matching key.
	UUID string
	// InboundRemoteID is the inbound this client belongs to, where the family
	// scopes clients to one.
	InboundRemoteID string
	Enabled         bool
	// DataLimitBytes is the ceiling the panel is currently enforcing. Zero
	// means the panel reports no limit, which under ADR-0072 rule 2 is a
	// finding and not a default: a limit higher than ours is a money hole and
	// is overwritten immediately.
	DataLimitBytes int64
	// RateLimitBps is the per-client bandwidth cap the panel is enforcing.
	RateLimitBps int64
	// ExpiresAt is the panel's own expiry, where it enforces one
	// (RowServerSideExpiry). Zero means none.
	ExpiresAt time.Time
}

// CreateClientRequest is what provisioning asks for. The driver turns it into
// whatever the family calls these things.
type CreateClientRequest struct {
	// ClaimTag is ours and global (invariant 17). It goes into the client's
	// label on every family that has one, and it is why a rename on the panel
	// does not orphan a user's usage.
	ClaimTag string
	// UUID is the config's own Xray identity (invariant 1).
	UUID            string
	InboundRemoteID string
	Protocol        string
	// DataLimitBytes is the ceiling to create the client under. A metered
	// client is created with its first block already written, never with no
	// limit and a ceiling applied afterwards — the gap between the two is
	// unpaid traffic.
	DataLimitBytes int64
	RateLimitBps   int64
	ExpiresAt      time.Time
	Enabled        bool
}

// UpdateClientRequest changes a client that already exists. Every field is
// what the client should now be, not a delta: the convergence loop compares
// desired state as it is now, so a partially applied update is re-applied
// rather than replayed (F-027-z).
type UpdateClientRequest struct {
	RemoteID        string
	ClaimTag        string
	UUID            string
	InboundRemoteID string
	DataLimitBytes  int64
	RateLimitBps    int64
	ExpiresAt       time.Time
	Enabled         bool
}

// ClientUsage is one reading of one client's counter, as the panel reports it
// — raw, and never a delta. What the figure means depends on the panel's
// declared CounterSemantics, and turning the three meanings into one delta
// stream is the normaliser's job (F-027-l), not this type's.
type ClientUsage struct {
	RemoteID string
	// UpBytes and DownBytes are the family's own figures. A family reporting
	// one total puts it in DownBytes and leaves UpBytes at zero rather than
	// splitting it, because a split we invented is a number nobody measured.
	UpBytes   int64
	DownBytes int64
	// ObservedAt is when the driver read the figure, not when the panel says
	// it was true. The plausibility cap is elapsed time times line rate, and
	// it is our clock that bounds it (F-027-l).
	ObservedAt time.Time
	// SessionID is set only where CounterSemantics is session: the identity of
	// the session this reading belongs to, which is what makes a restored
	// backup harmless (ADR-0074).
	SessionID string
}
