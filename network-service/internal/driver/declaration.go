// Package driver is the panel abstraction: one interface over six unrelated
// families of management system, and the declaration that says how each one
// counts and who starts the conversation (ADR-0074).
//
// Nothing outside this package knows what an inbound, a UUID or an x-ui
// session cookie is, and nothing downstream of the normaliser knows which
// family a byte came from. Anything a family needs is a declared capability
// here, or it does not exist.
package driver

// The four declaration enums mirror `network.prisma` exactly. They are the
// Panel's own columns, not JSON, because they select behaviour: the delta
// arithmetic, the direction of the conversation and whether the panel is
// allowed to carry users at all.

// Transport is who starts the conversation: we poll it, or it sends us
// accounting packets (`network.PanelTransport`).
type Transport string

const (
	TransportPull Transport = "pull"
	TransportPush Transport = "push"
)

// CounterSemantics is how the source counts (`network.CounterSemantics`). The
// delta arithmetic differs per value and a wrong declaration is a plausible
// wrong number, never a crash, which is why it is answered by the connection
// test and never by hand.
type CounterSemantics string

const (
	// CounterCumulative is a per-client total that rises and occasionally
	// resets. A figure below the cursor is a reset, never negative usage.
	CounterCumulative CounterSemantics = "cumulative"
	// CounterSession is a per-session high-water mark. Structurally immune to
	// the backup-restore catastrophe: a restored session carries an id we
	// have already closed.
	CounterSession CounterSemantics = "session"
	// CounterResetOnRead is zeroed by the act of reading it. If the publish
	// after the read fails, those bytes are gone permanently.
	CounterResetOnRead CounterSemantics = "reset_on_read"
)

// ReviewState is the registration verdict (`network.PanelReviewState`). A
// panel is refused here — before it has users on it — rather than at billing
// time.
type ReviewState string

const (
	ReviewPending          ReviewState = "pending"
	ReviewAccepted         ReviewState = "accepted"
	ReviewAcceptedLowTrust ReviewState = "accepted_low_trust"
	ReviewRefused          ReviewState = "refused"
)

// Collectable says whether a panel in this state may be collected or
// converged at all. Only a verdict of acceptance opens it: a pending panel has
// not answered the questionnaire and a refused one failed it, and the empty
// state is a row nobody read — so this fails closed (F-027-aq).
func (s ReviewState) Collectable() bool {
	return s == ReviewAccepted || s == ReviewAcceptedLowTrust
}

// DriverType is the family (`network.DriverType`). It selects the
// implementation and nothing else: two panels of the same family can still
// answer the questionnaire differently, because a version or a configuration
// changes what the install can actually do.
type DriverType string

const (
	DriverMarzban             DriverType = "marzban"
	DriverMarzneshin          DriverType = "marzneshin"
	DriverSanaee              DriverType = "sanaee"
	DriverXUI                 DriverType = "x_ui"
	DriverThreeXUI            DriverType = "three_x_ui"
	DriverSUI                 DriverType = "s_ui"
	DriverHiddify             DriverType = "hiddify"
	DriverCoreXray            DriverType = "core_xray"
	DriverIBSng               DriverType = "ibsng"
	DriverCloudius            DriverType = "cloudius"
	DriverMikrotikUserManager DriverType = "mikrotik_user_manager"
	DriverMikrotikWireGuard   DriverType = "mikrotik_wireguard"
	DriverFake                DriverType = "fake"
)
