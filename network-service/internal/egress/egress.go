// Package egress is the one way this service dials a panel (F-027-dl).
//
// A panel's address is typed by whoever registers it, and this process holds
// the cross-tenant role (ADR-0071). Pointed at 169.254.169.254, at Postgres or
// at tenant-service's vault route, a driver would be a request forged from
// inside the network (SPEC weakness #26); pointed at a panel that answers 5 GB,
// it would be a process out of memory (#27).
//
// The check is on the address the socket connects to, not on the name in the
// url: net.Dialer's Control runs after resolution, once per address tried. So
// a name that resolves public at registration and private at the next pass
// (DNS rebinding) is refused, and so is every redirect hop, because a
// redirect is only another dial through the same transport. Nothing is
// resolved twice, so nothing can change between the check and the connect.
package egress

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"syscall"
	"time"
)

// DefaultMaxBody is the most one answer may carry. The largest real answer is
// a busy x-ui's inbound list, every client's settings and stats inline — a
// few MB for ten thousand clients — so this is headroom, not a fit.
const DefaultMaxBody int64 = 64 << 20

// ErrRefused is a dial to an address no panel may have. A driver sees it as a
// transport error and classifies it `unavailable`; the detail names the address.
var ErrRefused = errors.New("egress: refused")

// ErrBodyTooLarge is an answer past the cap. A driver sees a read error.
var ErrBodyTooLarge = errors.New("egress: response body past the cap")

// Guard is what a panel may be. The zero value refuses every inward address
// and caps at DefaultMaxBody.
type Guard struct {
	// Allow opens private ranges the operator vouches for — a router reached
	// over the platform's own VPN (PANEL_EGRESS_ALLOW_CIDRS). Only a platform
	// panel's guard carries it (ADR-0095); opener.Opener picks per panel.
	Allow []netip.Prefix
	// MaxBody is the cap on one answer; zero is DefaultMaxBody.
	MaxBody int64
}

// inward is every range that is not a panel on the internet. IsPrivate,
// IsLoopback and the link-local checks cover the rest (check).
var inward = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),     // "this network"
	netip.MustParsePrefix("100.64.0.0/10"), // CGNAT; Alibaba's metadata is 100.100.100.200
	netip.MustParsePrefix("192.0.0.0/24"),  // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"), // benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),   // reserved, and the broadcast address
	netip.MustParsePrefix("64:ff9b::/96"),  // NAT64: an IPv4 address the gateway would dial for us
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2002::/16"), // 6to4, the same
	netip.MustParsePrefix("2001::/32"), // Teredo, the same
}

func (g Guard) check(a netip.Addr) error {
	a = a.Unmap()
	for _, p := range g.Allow {
		if p.Contains(a) {
			return nil
		}
	}
	var why string
	switch {
	case a.IsLoopback():
		why = "loopback"
	case a.IsPrivate():
		why = "private"
	case a.IsLinkLocalUnicast(), a.IsLinkLocalMulticast():
		why = "link-local"
	case a.IsUnspecified():
		why = "unspecified"
	case a.IsMulticast(), a.IsInterfaceLocalMulticast():
		why = "multicast"
	default:
		for _, p := range inward {
			if p.Contains(a) {
				why = "reserved (" + p.String() + ")"
				break
			}
		}
	}
	if why != "" {
		return fmt.Errorf("%w: %s is a %s address", ErrRefused, a, why)
	}
	return nil
}

// control is net.Dialer.Control: the address here is the one being connected.
func (g Guard) control(_, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("%w: %q is not an address", ErrRefused, address)
	}
	return g.check(ap.Addr())
}

// Client is the http.Client every driver speaks through. It has no timeout of
// its own — the caller's context is the deadline (driver.Driver) — and no
// proxy: an HTTP_PROXY in the environment would be dialed instead of the
// panel, and the guard would be checking the proxy.
func Client(g Guard) *http.Client {
	if g.MaxBody <= 0 {
		g.MaxBody = DefaultMaxBody
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DialContext = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second, Control: g.control}).DialContext
	return &http.Client{Transport: &bodyCap{next: tr, max: g.MaxBody}}
}

// ParseAllow reads PANEL_EGRESS_ALLOW_CIDRS: comma-separated ranges. A bare
// address is refused rather than read as a /32, so a typo cannot open more,
// or less, than the operator meant.
func ParseAllow(raw string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return nil, fmt.Errorf("PANEL_EGRESS_ALLOW_CIDRS: %q is not a range (want e.g. 10.8.0.0/24)", s)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}

// bodyCap cuts every answer at max: the read past it fails, so a decoder
// stops with an error instead of the process holding what a panel sent.
type bodyCap struct {
	next http.RoundTripper
	max  int64
}

func (b *bodyCap) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := b.next.RoundTrip(r)
	if err != nil || resp.Body == nil {
		return resp, err
	}
	resp.Body = &capped{rc: resp.Body, left: b.max}
	return resp, nil
}

type capped struct {
	rc   io.ReadCloser
	left int64
}

func (c *capped) Read(p []byte) (int, error) {
	if c.left < 0 {
		return 0, ErrBodyTooLarge
	}
	// One byte past the cap is read, to tell "exactly the cap" from "more".
	if int64(len(p)) > c.left+1 {
		p = p[:c.left+1]
	}
	n, err := c.rc.Read(p)
	c.left -= int64(n)
	if c.left < 0 {
		return n + int(c.left), ErrBodyTooLarge
	}
	return n, err
}

func (c *capped) Close() error { return c.rc.Close() }
