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
// CDN names the person in a header of its own, or else in the entry it
// appended to `X-Forwarded-For` just before Cloudflare appended the edge.
// Nothing can verify either, so it is forwarded as a claim
// (`X-Edge-Claimed-Ip`) beside the address and never replaces it. The limiter
// counts it, and nothing else reads it (ADR-0129 amendment 2, EDGE-1-k/m).
//
// Reading `X-Forwarded-For` needs the entrypoint to keep forwarded headers
// (`forwardedHeaders.insecure`). That makes this middleware the one place
// they are made: every `X-Forwarded-*` and `X-Real-Ip` a request arrives with
// is discarded and rewritten from the request itself, as Traefik does for an
// untrusted sender. A client's `X-Forwarded-Host` would otherwise choose the
// tenant (EDGE-1-m).
//
// A domestic edge (NIN-1-b4, ADR-0165 amendment 2) comes in on the same 443
// with no certificate: Arvan sends none (NIN-1-a). It is known by its address
// alone, inside the ranges edge_ranges.py keeps for the firewall (hosting O7,
// O8). From there `visitorHeader` names the header that edge overwrites with
// the visitor (Arvan's X-Real-IP), and it alone is read: CF-Connecting-IP,
// the claim headers and X-Forwarded-For, which Arvan keeps from the client,
// are dropped and no claim is made.
//
// With `requirePull` (O3 `required`), a TLS request that is neither a verified
// pull nor from a domestic edge is refused here. The handshake asks for the
// certificate without demanding it, because a domestic edge has none; a
// Cloudflare pull without ours is any free zone (O1).
//
// Every request also leaves with `X-Edge-Door`, whatever a client sent:
// `cloudflare` for a verified pull, `domestic` from a domestic edge, `direct`
// otherwise. The domain check reads it to tell a reseller's approved edge from
// Cloudflare or no edge at all (NIN-1-e2); nothing authorizes on it.
package edgeclientip

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
)

const (
	cfConnectingIP = "CF-Connecting-IP"
	claimedIP      = "X-Edge-Claimed-Ip"
	forwardedFor   = "X-Forwarded-For"
	edgeDoor       = "X-Edge-Door"
)

// defaultClaimHeaders: where CDNs put the visitor's address — Akamai, Arvan,
// Fastly, Azure Front Door, CloudFront (`ip:port`). A CDN not listed is read
// from `X-Forwarded-For`.
var defaultClaimHeaders = []string{
	"True-Client-IP", "AR-Real-IP", "Fastly-Client-IP", "X-Azure-ClientIP", "CloudFront-Viewer-Address",
}

// Made by this middleware alone; whatever a request arrives with is dropped.
var forwardedHeaders = []string{
	forwardedFor, "X-Real-Ip", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port",
	"X-Forwarded-Server", "X-Forwarded-Prefix", "X-Forwarded-Uri", "X-Forwarded-Method",
	"X-Forwarded-Tls-Client-Cert", "X-Forwarded-Tls-Client-Cert-Info",
}

// Config: ClaimHeaders is the order a CDN's claim is looked for in; empty
// means the defaults. VisitorHeader and EdgeRangeFiles come from the domestic
// edges' rows in scripts/edge/edges.json: where they name the visitor, and
// the last good copies of their ranges. RequirePull is O3 `required`.
type Config struct {
	ClaimHeaders   []string `json:"claimHeaders,omitempty"`
	VisitorHeader  string   `json:"visitorHeader,omitempty"`
	EdgeRangeFiles []string `json:"edgeRangeFiles,omitempty"`
	RequirePull    bool     `json:"requirePull,omitempty"`
}

// CreateConfig is Traefik's plugin entry point for the configuration.
func CreateConfig() *Config { return &Config{} }

type edgeClientIP struct {
	next          http.Handler
	claimHeaders  []string
	visitorHeader string
	ranges        *edgeRanges
	requirePull   bool
}

// New is Traefik's plugin entry point for the middleware.
func New(_ context.Context, next http.Handler, cfg *Config, _ string) (http.Handler, error) {
	if cfg == nil {
		cfg = CreateConfig()
	}
	if len(cfg.EdgeRangeFiles) > 0 && cfg.VisitorHeader == "" {
		return nil, errors.New("edgeRangeFiles needs visitorHeader: where those edges name the visitor")
	}
	headers := defaultClaimHeaders
	if len(cfg.ClaimHeaders) > 0 {
		headers = cfg.ClaimHeaders
	}
	return &edgeClientIP{
		next: next, claimHeaders: headers, visitorHeader: cfg.VisitorHeader,
		ranges: newEdgeRanges(cfg.EdgeRangeFiles), requirePull: cfg.RequirePull,
	}, nil
}

func (e *edgeClientIP) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	pulled := verifiedPull(req)
	if !pulled && e.fromDomesticEdge(req.RemoteAddr) {
		e.serveDomestic(rw, req)
		return
	}
	if e.requirePull && req.TLS != nil && !pulled {
		http.Error(rw, http.StatusText(http.StatusForbidden), http.StatusForbidden)
		return
	}
	cfVisitor := net.ParseIP(strings.TrimSpace(req.Header.Get(cfConnectingIP)))
	chain := req.Header.Values(forwardedFor)
	var cdnClaim net.IP
	for _, h := range e.claimHeaders {
		if cdnClaim == nil {
			cdnClaim = parseAddress(req.Header.Get(h))
		}
		// One name for services to read, not one per CDN.
		req.Header.Del(h)
	}
	req.Header.Del(cfConnectingIP)
	req.Header.Del(claimedIP)
	rewriteForwarded(req)
	door := "direct"
	if pulled {
		door = "cloudflare"
	}
	req.Header.Set(edgeDoor, door)

	if cfVisitor != nil && pulled {
		setVisitor(req, cfVisitor)
		if cdnClaim == nil {
			cdnClaim = appendedBefore(chain, cfVisitor)
		}
		if cdnClaim != nil && !cdnClaim.Equal(cfVisitor) {
			req.Header.Set(claimedIP, cdnClaim.String())
		}
	}
	e.next.ServeHTTP(rw, req)
}

// fromDomesticEdge: the socket's address is inside a domestic edge's ranges.
// With no visitor header configured there is no domestic edge (dev, NIN-1-b4).
func (e *edgeClientIP) fromDomesticEdge(remoteAddr string) bool {
	return e.visitorHeader != "" && e.ranges.contains(remoteAddr)
}

// serveDomestic: the edge's own header, one IP, is the visitor; every other
// name a client could have set is dropped first. A missing or malformed value
// leaves the socket's address, which is that edge's.
func (e *edgeClientIP) serveDomestic(rw http.ResponseWriter, req *http.Request) {
	visitor := net.ParseIP(strings.TrimSpace(req.Header.Get(e.visitorHeader)))
	for _, h := range e.claimHeaders {
		req.Header.Del(h)
	}
	req.Header.Del(e.visitorHeader)
	req.Header.Del(cfConnectingIP)
	req.Header.Del(claimedIP)
	rewriteForwarded(req)
	req.Header.Set(edgeDoor, "domestic")
	if visitor != nil {
		setVisitor(req, visitor)
	}
	e.next.ServeHTTP(rw, req)
}

// setVisitor makes ip the client address: RemoteAddr, from which Traefik's
// proxy writes X-Forwarded-For, and X-Real-Ip. The socket's port is kept.
func setVisitor(req *http.Request, ip net.IP) {
	port := "0"
	if _, p, err := net.SplitHostPort(req.RemoteAddr); err == nil {
		port = p
	}
	req.RemoteAddr = net.JoinHostPort(ip.String(), port)
	req.Header.Set("X-Real-Ip", ip.String())
}

// rewriteForwarded drops every forwarded header and writes the ones Traefik
// writes for an untrusted sender, spelled as Traefik spells them. Traefik's
// proxy appends RemoteAddr to the emptied `X-Forwarded-For`.
func rewriteForwarded(req *http.Request) {
	for _, h := range forwardedHeaders {
		req.Header.Del(h)
	}
	proto := "http"
	if req.TLS != nil {
		proto = "https"
	}
	if isWebSocket(req) {
		proto = map[string]string{"http": "ws", "https": "wss"}[proto]
	}
	req.Header.Set("X-Forwarded-Proto", proto)
	if req.Host != "" {
		req.Header.Set("X-Forwarded-Host", req.Host)
	}
	port := "80"
	if _, p, err := net.SplitHostPort(req.Host); err == nil && p != "" {
		port = p
	} else if req.TLS != nil {
		port = "443"
	}
	req.Header.Set("X-Forwarded-Port", port)
	if host, _, err := net.SplitHostPort(req.RemoteAddr); err == nil {
		req.Header.Set("X-Real-Ip", host)
	}
}

// appendedBefore: Cloudflare appends the address it saw (the CDN's edge) to
// the `X-Forwarded-For` it received, and that CDN appended the visitor just
// before. So the claim is the entry before the last, and only when the last
// is that edge: any other shape is not a CDN in front of Cloudflare.
func appendedBefore(chain []string, edge net.IP) net.IP {
	var entries []string
	for _, line := range chain {
		for _, entry := range strings.Split(line, ",") {
			entries = append(entries, strings.TrimSpace(entry))
		}
	}
	if len(entries) < 2 {
		return nil
	}
	if last := net.ParseIP(entries[len(entries)-1]); last == nil || !last.Equal(edge) {
		return nil
	}
	return net.ParseIP(entries[len(entries)-2])
}

// parseAddress takes one IP, or one IP with a port (CloudFront writes
// `ip:port`, an IPv6 address unbracketed).
func parseAddress(raw string) net.IP {
	raw = strings.TrimSpace(raw)
	if ip := net.ParseIP(raw); ip != nil {
		return ip
	}
	if host, _, err := net.SplitHostPort(raw); err == nil {
		return net.ParseIP(host)
	}
	if i := strings.LastIndex(raw, ":"); i > 0 {
		return net.ParseIP(raw[:i])
	}
	return nil
}

func isWebSocket(req *http.Request) bool {
	return strings.Contains(strings.ToLower(req.Header.Get("Connection")), "upgrade") &&
		strings.EqualFold(req.Header.Get("Upgrade"), "websocket")
}

// verifiedPull: the client presented a certificate that chained to the CA in
// the TLS options. With `VerifyClientCertIfGiven` a connection may present
// none, and then this is false.
func verifiedPull(req *http.Request) bool {
	return req.TLS != nil && len(req.TLS.VerifiedChains) > 0
}
