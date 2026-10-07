// Package edgeclientip is a Traefik middleware that makes the visitor's
// address the request's client address when, and only when, the request is a
// verified Cloudflare origin pull (ADR-0129 amendment 1, EDGE-1-g).
//
// Cloudflare reaches the origin from its own addresses, so without this every
// visitor shares a handful of edge addresses and a per-caller rate limit
// (ADR-0070) becomes a per-edge one. Cloudflare names the visitor in
// `CF-Connecting-IP`, but anyone can send that header. What only Cloudflare
// can do is present the client certificate issued by our own origin-pull CA,
// which the websecure entrypoint's TLS options check. So the header counts
// only when the connection's client chain verified; otherwise it is dropped.
//
// The address is written to `RemoteAddr`, from which Traefik's proxy writes
// `X-Forwarded-For`, and to `X-Real-Ip`. Services keep reading the one hop
// they already trust (`trustProxySetting`) and change nothing.
package edgeclientip

import (
	"context"
	"net"
	"net/http"
	"strings"
)

const cfConnectingIP = "CF-Connecting-IP"

// Config is empty: the trust decision is the TLS options', not this file's.
type Config struct{}

// CreateConfig is Traefik's plugin entry point for the configuration.
func CreateConfig() *Config { return &Config{} }

type edgeClientIP struct{ next http.Handler }

// New is Traefik's plugin entry point for the middleware.
func New(_ context.Context, next http.Handler, _ *Config, _ string) (http.Handler, error) {
	return &edgeClientIP{next: next}, nil
}

func (e *edgeClientIP) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	claimed := strings.TrimSpace(req.Header.Get(cfConnectingIP))
	// No service reads it: the address it names is RemoteAddr or nothing.
	req.Header.Del(cfConnectingIP)

	if visitor := net.ParseIP(claimed); visitor != nil && verifiedPull(req) {
		port := "0"
		if _, p, err := net.SplitHostPort(req.RemoteAddr); err == nil {
			port = p
		}
		req.RemoteAddr = net.JoinHostPort(visitor.String(), port)
		req.Header.Set("X-Real-Ip", visitor.String())
		req.Header.Del("X-Forwarded-For")
	}
	e.next.ServeHTTP(rw, req)
}

// verifiedPull: the client presented a certificate that chained to the CA in
// the TLS options. With `VerifyClientCertIfGiven` a connection may present
// none, and then this is false.
func verifiedPull(req *http.Request) bool {
	return req.TLS != nil && len(req.TLS.VerifiedChains) > 0
}
