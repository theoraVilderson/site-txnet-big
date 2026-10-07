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
//
// Behind a reseller's own CDN, that verified address is the CDN's edge. The
// CDN names the person in a header of its own, which nothing can verify, so it
// is forwarded as a claim (`X-Edge-Claimed-Ip`) beside the address and never
// replaces it. The limiter counts it, and nothing else reads it (ADR-0129
// amendment 2, EDGE-1-k). `X-Forwarded-For` cannot carry it: Traefik has already
// dropped that header from an untrusted sender by the time this runs.
package edgeclientip

import (
	"context"
	"net"
	"net/http"
	"strings"
)

const (
	cfConnectingIP = "CF-Connecting-IP"
	claimedIP      = "X-Edge-Claimed-Ip"
)

// defaultClaimHeaders: where CDNs put the visitor's address — Akamai, Arvan,
// Fastly. A CDN not listed counts as one caller, as before amendment 2.
var defaultClaimHeaders = []string{"True-Client-IP", "AR-Real-IP", "Fastly-Client-IP"}

// Config holds no trust decision: that is the TLS options'. ClaimHeaders is
// the order a CDN's claim is looked for in; empty means the defaults.
type Config struct {
	ClaimHeaders []string `json:"claimHeaders,omitempty"`
}

// CreateConfig is Traefik's plugin entry point for the configuration.
func CreateConfig() *Config { return &Config{} }

type edgeClientIP struct {
	next         http.Handler
	claimHeaders []string
}

// New is Traefik's plugin entry point for the middleware.
func New(_ context.Context, next http.Handler, cfg *Config, _ string) (http.Handler, error) {
	headers := defaultClaimHeaders
	if cfg != nil && len(cfg.ClaimHeaders) > 0 {
		headers = cfg.ClaimHeaders
	}
	return &edgeClientIP{next: next, claimHeaders: headers}, nil
}

func (e *edgeClientIP) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	claimed := strings.TrimSpace(req.Header.Get(cfConnectingIP))
	// No service reads it: the address it names is RemoteAddr or nothing.
	req.Header.Del(cfConnectingIP)
	// The claim is only ever this middleware's, so a client's is dropped, and
	// the CDNs' own headers with it: one name for services to read, not three.
	req.Header.Del(claimedIP)
	var cdnClaim net.IP
	for _, h := range e.claimHeaders {
		if cdnClaim == nil {
			cdnClaim = net.ParseIP(strings.TrimSpace(req.Header.Get(h)))
		}
		req.Header.Del(h)
	}

	if visitor := net.ParseIP(claimed); visitor != nil && verifiedPull(req) {
		port := "0"
		if _, p, err := net.SplitHostPort(req.RemoteAddr); err == nil {
			port = p
		}
		req.RemoteAddr = net.JoinHostPort(visitor.String(), port)
		req.Header.Set("X-Real-Ip", visitor.String())
		req.Header.Del("X-Forwarded-For")
		if cdnClaim != nil && !cdnClaim.Equal(visitor) {
			req.Header.Set(claimedIP, cdnClaim.String())
		}
	}
	e.next.ServeHTTP(rw, req)
}

// verifiedPull: the client presented a certificate that chained to the CA in
// the TLS options. With `VerifyClientCertIfGiven` a connection may present
// none, and then this is false.
func verifiedPull(req *http.Request) bool {
	return req.TLS != nil && len(req.TLS.VerifiedChains) > 0
}
