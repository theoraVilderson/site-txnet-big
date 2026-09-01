package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"time"
)

// socks5Dialer is a minimal SOCKS5 client (CONNECT command only, with
// optional username/password auth) implemented against the raw protocol
// using nothing but net/net.Dialer from the standard library — no
// golang.org/x/net/proxy or any other external dependency.
type socks5Dialer struct {
	proxyAddr string // e.g. "127.0.0.1:1080"
	user      string
	pass      string
}

// newSocks5DialerFromEnv reads SOCKS proxy settings from the environment
// (normally populated via .env):
//
//	SOCKS_PROXY       host:port of the SOCKS5 proxy. If unset, no SOCKS
//	                  proxy is used and outbound requests go direct.
//	SOCKS_PROXY_USER  (optional) username, if the proxy requires auth.
//	SOCKS_PROXY_PASS  (optional) password.
//
// Returns nil when SOCKS_PROXY is not set.
func newSocks5DialerFromEnv() *socks5Dialer {
	addr := os.Getenv("SOCKS_PROXY")
	if addr == "" {
		return nil
	}
	return &socks5Dialer{
		proxyAddr: addr,
		user:      os.Getenv("SOCKS_PROXY_USER"),
		pass:      os.Getenv("SOCKS_PROXY_PASS"),
	}
}

// DialContext matches the signature http.Transport.DialContext expects, so
// a *socks5Dialer can be dropped straight in as the transport's dialer.
func (d *socks5Dialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	var nd net.Dialer
	conn, err := nd.DialContext(ctx, "tcp", d.proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("socks5: dial proxy %s: %w", d.proxyAddr, err)
	}

	// Respect context cancellation/deadline during the handshake, since the
	// handshake itself uses blocking conn.Read/Write with no ctx awareness.
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
		defer conn.SetDeadline(time.Time{})
	}

	if err := d.handshake(conn); err != nil {
		conn.Close()
		return nil, err
	}
	if err := d.connect(conn, addr); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// handshake performs the SOCKS5 method negotiation (RFC 1928 §3).
func (d *socks5Dialer) handshake(conn net.Conn) error {
	methods := []byte{0x00} // no-auth
	if d.user != "" {
		methods = []byte{0x02, 0x00} // prefer user/pass, fall back to no-auth
	}
	req := append([]byte{0x05, byte(len(methods))}, methods...)
	if _, err := conn.Write(req); err != nil {
		return fmt.Errorf("socks5: method negotiation write: %w", err)
	}

	resp := make([]byte, 2)
	if _, err := io.ReadFull(conn, resp); err != nil {
		return fmt.Errorf("socks5: method negotiation read: %w", err)
	}
	if resp[0] != 0x05 {
		return errors.New("socks5: unexpected protocol version in method response")
	}
	switch resp[1] {
	case 0x00:
		return nil // no auth required
	case 0x02:
		return d.authenticate(conn)
	case 0xFF:
		return errors.New("socks5: proxy rejected all offered auth methods")
	default:
		return fmt.Errorf("socks5: unsupported auth method 0x%02x", resp[1])
	}
}

// authenticate performs SOCKS5 username/password auth (RFC 1929).
func (d *socks5Dialer) authenticate(conn net.Conn) error {
	if len(d.user) > 255 || len(d.pass) > 255 {
		return errors.New("socks5: username/password too long (max 255 bytes each)")
	}
	req := []byte{0x01}
	req = append(req, byte(len(d.user)))
	req = append(req, d.user...)
	req = append(req, byte(len(d.pass)))
	req = append(req, d.pass...)
	if _, err := conn.Write(req); err != nil {
		return fmt.Errorf("socks5: auth write: %w", err)
	}

	resp := make([]byte, 2)
	if _, err := io.ReadFull(conn, resp); err != nil {
		return fmt.Errorf("socks5: auth read: %w", err)
	}
	if resp[1] != 0x00 {
		return errors.New("socks5: authentication failed")
	}
	return nil
}

// connect sends the CONNECT request for addr ("host:port") and reads the
// reply (RFC 1928 §4/§6).
func (d *socks5Dialer) connect(conn net.Conn, addr string) error {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("socks5: invalid target address %q: %w", addr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return fmt.Errorf("socks5: invalid target port %q", portStr)
	}

	req := []byte{0x05, 0x01, 0x00} // VER, CMD=CONNECT, RSV

	if ip := net.ParseIP(host); ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			req = append(req, 0x01) // ATYP=IPv4
			req = append(req, ip4...)
		} else {
			req = append(req, 0x04) // ATYP=IPv6
			req = append(req, ip.To16()...)
		}
	} else {
		if len(host) > 255 {
			return errors.New("socks5: target hostname too long")
		}
		req = append(req, 0x03, byte(len(host))) // ATYP=domain name
		req = append(req, host...)
	}
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, uint16(port))
	req = append(req, portBytes...)

	if _, err := conn.Write(req); err != nil {
		return fmt.Errorf("socks5: connect write: %w", err)
	}

	// Reply layout: VER REP RSV ATYP BND.ADDR BND.PORT
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return fmt.Errorf("socks5: connect read: %w", err)
	}
	if head[0] != 0x05 {
		return errors.New("socks5: unexpected protocol version in connect reply")
	}
	if head[1] != 0x00 {
		return fmt.Errorf("socks5: proxy refused CONNECT, reply code 0x%02x (%s)", head[1], socks5ReplyText(head[1]))
	}

	// Drain BND.ADDR + BND.PORT, whose length depends on ATYP. We don't
	// need the values, just to consume them off the wire.
	switch head[3] {
	case 0x01: // IPv4
		if _, err := io.ReadFull(conn, make([]byte, net.IPv4len+2)); err != nil {
			return fmt.Errorf("socks5: reading IPv4 bind addr: %w", err)
		}
	case 0x03: // domain name
		lenBuf := make([]byte, 1)
		if _, err := io.ReadFull(conn, lenBuf); err != nil {
			return fmt.Errorf("socks5: reading bind domain length: %w", err)
		}
		if _, err := io.ReadFull(conn, make([]byte, int(lenBuf[0])+2)); err != nil {
			return fmt.Errorf("socks5: reading bind domain: %w", err)
		}
	case 0x04: // IPv6
		if _, err := io.ReadFull(conn, make([]byte, net.IPv6len+2)); err != nil {
			return fmt.Errorf("socks5: reading IPv6 bind addr: %w", err)
		}
	default:
		return errors.New("socks5: unknown address type in connect reply")
	}

	return nil
}

func socks5ReplyText(code byte) string {
	switch code {
	case 0x01:
		return "general SOCKS server failure"
	case 0x02:
		return "connection not allowed by ruleset"
	case 0x03:
		return "network unreachable"
	case 0x04:
		return "host unreachable"
	case 0x05:
		return "connection refused"
	case 0x06:
		return "TTL expired"
	case 0x07:
		return "command not supported"
	case 0x08:
		return "address type not supported"
	default:
		return "unknown error"
	}
}
