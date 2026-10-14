// Package anchor is how a panel is known (ADR-0130). Our clients on a server
// prove which server it is only while it holds some; an empty, reinstalled or
// foreign server behind a re-pointed address holds none. So every pull panel
// carries one more client of its own — the anchor: disabled, a 1-byte limit,
// no expiry, a random `anchor-` tag and a fresh uuid — and `network.panel`
// keeps both, with the id the panel gave it.
//
// The anchor is never an orphan, a seat, billed or converged: it is not a
// config, and every reader of a panel's clients leaves it out by Is.
//
// The connection test's canary is made the same way (Create), so a family
// that cannot make one cannot make the other, and is never accepted past it.
package anchor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"network-service/internal/driver"
)

// TagPrefix starts every anchor's tag, so a person reading the panel's client
// list can tell it from a user's.
const TagPrefix = "anchor-"

// tagBytes is the random part of a marker's tag: 8 bytes, 16 hex characters.
const tagBytes = 8

// Anchor is one panel's anchor as `network.panel` holds it. The zero value is
// a panel that has none yet.
type Anchor struct {
	Tag      string
	UUID     string
	RemoteID string
}

// Planted says the panel has one.
func (a Anchor) Planted() bool { return a.Tag != "" }

// Is says whether c is this anchor, by tag or by uuid: the panel may re-key
// it, but our tag and uuid are ours.
func (a Anchor) Is(c driver.RemoteClient) bool {
	return a.Planted() && ((c.Label != "" && c.Label == a.Tag) || (c.UUID != "" && c.UUID == a.UUID))
}

// In finds the anchor among a panel's clients.
func (a Anchor) In(clients []driver.RemoteClient) (driver.RemoteClient, bool) {
	for _, c := range clients {
		if a.Is(c) {
			return c, true
		}
	}
	return driver.RemoteClient{}, false
}

// Without is clients less the anchor: what a pass reads as the panel's users.
func (a Anchor) Without(clients []driver.RemoteClient) []driver.RemoteClient {
	if !a.Planted() {
		return clients
	}
	out := make([]driver.RemoteClient, 0, len(clients))
	for _, c := range clients {
		if !a.Is(c) {
			out = append(out, c)
		}
	}
	return out
}

// Plant creates a new anchor through d, on the first of its enabled inbounds
// the family will create a client on.
func Plant(ctx context.Context, d driver.Driver) (Anchor, error) {
	inbounds, err := Inbounds(ctx, d)
	if err != nil {
		return Anchor{}, err
	}
	return Create(ctx, d, inbounds, TagPrefix, time.Time{})
}

// Inbound is where a marker client is created: the panel's id for it and its
// protocol. Zero is a family that scopes clients to no inbound (Hiddify).
type Inbound struct {
	RemoteID string
	Protocol string
}

// Inbounds is every enabled inbound d lists, in its order; a family that
// lists none gets the zero Inbound, which scopes nothing.
func Inbounds(ctx context.Context, d driver.Driver) ([]Inbound, error) {
	listed, err := d.ListInbounds(ctx)
	if err != nil {
		return nil, err
	}
	var out []Inbound
	for _, in := range listed {
		if in.Enabled {
			out = append(out, Inbound{RemoteID: in.RemoteID, Protocol: in.Protocol})
		}
	}
	if len(out) == 0 {
		out = []Inbound{{}}
	}
	return out, nil
}

// Create makes a disabled marker client through d — an anchor, or the
// duplicate check's canary — under prefix and a random tag and uuid, on the
// first of inbounds the family takes it on. An inbound it answers
// `unsupported` for (a socks inbound on x-ui) is passed over, since only the
// family knows which protocols it provisions. A zero expiresAt is no expiry.
func Create(ctx context.Context, d driver.Driver, inbounds []Inbound, prefix string, expiresAt time.Time) (Anchor, error) {
	tag, uuid := prefix+randomHex(tagBytes), NewUUID()
	err := errors.New("no inbound to create a client on")
	for _, inbound := range inbounds {
		var created driver.RemoteClient
		created, err = d.CreateClient(ctx, driver.CreateClientRequest{
			ClaimTag: tag, UUID: uuid, InboundRemoteID: inbound.RemoteID, Protocol: inbound.Protocol,
			// One byte, not zero: a family may read 0 as no limit. It is disabled anyway.
			DataLimitBytes: 1, ExpiresAt: expiresAt, Enabled: false,
		})
		if err == nil {
			return Anchor{Tag: tag, UUID: uuid, RemoteID: created.RemoteID}, nil
		}
		if kind, _ := driver.KindOf(err); kind != driver.FaultUnsupported {
			return Anchor{}, err
		}
	}
	return Anchor{}, err
}

// NewUUID is a random (v4) uuid.
func NewUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
