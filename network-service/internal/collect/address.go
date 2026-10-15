package collect

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"sync"

	"network-service/internal/driver"
	"network-service/internal/egress"
)

// The address check (F-027-ez, ADR-0130 decision 4). A panel registered by a
// name is held to the addresses its accepting test dialed. Every turn resolves
// the name once, before anything is sent, and the panel's driver dials only
// what that one lookup answered and the check let through (egress.Pin): there
// is no second lookup for a rebinding to slip into. No known address among
// the answers = the login is not sent, and a halting `address_moved` names the
// old addresses and the new ones until a person says the move is ours.

// Address is how a panel whose API host is a name is held to its server.
type Address struct {
	// Known is `panel.knownAddresses`. Empty is a panel accepted before
	// F-027-ez: its first turn learns what it resolves to.
	Known []netip.Addr
	// MayMove is `panel.addressMayMove`, the opt-out for a panel behind a CDN:
	// dialed wherever the turn's lookup answers; the anchor alone guards it.
	MayMove bool
	// Pin is what the panel's driver dials. Nil is a host that is an address,
	// or no host: there is nothing to look up.
	Pin *egress.Pin
}

// AddressBook records the addresses a panel accepted before F-027-ez learns.
type AddressBook interface {
	// Learn writes addrs onto a panel that knows none. False is a panel that
	// learned meanwhile — a re-test's verdict.
	Learn(ctx context.Context, panelID string, addrs []netip.Addr) (bool, error)
}

// ErrAddressMoved is a turn stopped by the address check; the event is raised.
var ErrAddressMoved = errors.New("panel's host resolves to none of the addresses it was accepted at; not called until the drift event is acknowledged")

// OpResolve is the `Op` of a turn whose lookup failed.
const OpResolve = "Resolve"

// locate is the address check. A lookup that fails is the panel unreachable,
// as a failed read is; a move raises the event and answers ErrAddressMoved.
func (l *Loop) locate(turnCtx, ctx context.Context, p *Panel) (string, error) {
	a := p.Address
	if a.Pin == nil || p.Host == "" {
		return "", nil
	}
	seen, err := l.resolve(ctx, p.Host)
	if err == nil && len(seen) == 0 {
		err = errors.New("no address")
	}
	if err != nil {
		fault := driver.NewFault(driver.FaultUnavailable, OpResolve, 0, fmt.Errorf("resolving %s: %w", p.Host, err))
		l.observe(turnCtx, p.ID, fault)
		return OpResolve, fault
	}
	switch {
	case len(a.Known) == 0:
		l.learn(ctx, p.ID, seen)
		a.Pin.Set(seen)
	case a.MayMove:
		a.Pin.Set(seen)
	default:
		dial := slices.DeleteFunc(slices.Clone(seen), func(ip netip.Addr) bool { return !slices.Contains(a.Known, ip) })
		a.Pin.Set(dial)
		if len(dial) == 0 {
			return l.moved(ctx, p, seen)
		}
	}
	return "", nil
}

// moved raises the halting event naming both sets.
func (l *Loop) moved(ctx context.Context, p *Panel, seen []netip.Addr) (string, error) {
	event := DriftEvent{
		PanelID: p.ID, Type: AddressMoved, DetectedAt: l.now(), CollectionHalted: true,
		KnownAddresses: addrStrings(p.Address.Known), SeenAddresses: addrStrings(seen),
	}
	if err := l.Containment.Raise(ctx, event); err != nil {
		return "Address", err
	}
	l.log().Error("panel's address moved; its login is not sent", "panel", p.ID, "host", p.Host,
		"known", event.KnownAddresses, "seen", event.SeenAddresses)
	return OpHalted, ErrAddressMoved
}

// learn records a first lookup. A panel whose write fails is still dialed at
// what this turn checked, and learns on the next.
func (l *Loop) learn(ctx context.Context, panelID string, seen []netip.Addr) {
	if l.Addresses == nil {
		return
	}
	if _, err := l.Addresses.Learn(ctx, panelID, seen); err != nil {
		l.log().Error("panel addresses not recorded", "panel", panelID, "error", err)
	}
}

func (l *Loop) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if l.Resolve != nil {
		return l.Resolve(ctx, host)
	}
	addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	for i := range addrs {
		addrs[i] = addrs[i].Unmap()
	}
	return addrs, err
}

func addrStrings(addrs []netip.Addr) []string {
	out := make([]string, len(addrs))
	for i, a := range addrs {
		out[i] = a.String()
	}
	return out
}

// ParseAddrs reads `knownAddresses` as stored; one that does not parse is
// dropped, never dialed.
func ParseAddrs(stored []string) []netip.Addr {
	var out []netip.Addr
	for _, s := range stored {
		if a, err := netip.ParseAddr(s); err == nil {
			out = append(out, a.Unmap())
		}
	}
	return out
}

// PostgresAddresses is AddressBook over `network.panel` (F-027-ez).
type PostgresAddresses struct{ DB DB }

var _ AddressBook = PostgresAddresses{}

// learnSQL writes over none only: a re-test's verdict already recorded what
// it dialed.
const learnSQL = `
UPDATE network.panel SET "knownAddresses" = $2::text[]
 WHERE id = $1::uuid AND cardinality("knownAddresses") = 0`

func (s PostgresAddresses) Learn(ctx context.Context, panelID string, addrs []netip.Addr) (bool, error) {
	tag, err := s.DB.Exec(ctx, learnSQL, panelID, addrStrings(addrs))
	if err != nil {
		return false, fmt.Errorf("recording panel %s addresses: %w", panelID, err)
	}
	return tag.RowsAffected() == 1, nil
}

// MemoryAddresses holds learned addresses in memory: what the loop is proved
// against.
type MemoryAddresses struct {
	mu      sync.Mutex
	byPanel map[string][]netip.Addr
}

func NewMemoryAddresses() *MemoryAddresses {
	return &MemoryAddresses{byPanel: map[string][]netip.Addr{}}
}

func (m *MemoryAddresses) Learn(_ context.Context, panelID string, addrs []netip.Addr) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.byPanel[panelID]) > 0 {
		return false, nil
	}
	m.byPanel[panelID] = slices.Clone(addrs)
	return true, nil
}

// Of is what the panel learned, else fallback: what the next read of its row holds.
func (m *MemoryAddresses) Of(panelID string, fallback []netip.Addr) []netip.Addr {
	m.mu.Lock()
	defer m.mu.Unlock()
	if learned := m.byPanel[panelID]; len(learned) > 0 {
		return slices.Clone(learned)
	}
	return fallback
}
