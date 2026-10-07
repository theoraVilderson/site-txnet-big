package edgeclientip

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"testing"
)

// seen is what the next handler — Traefik's proxy to the service — receives.
type seen struct {
	remoteAddr, realIP, forwardedFor, cfConnectingIP, claimed string
	trueClientIP, arRealIP                                    string
}

func serve(t *testing.T, req *http.Request) seen {
	t.Helper()
	return serveWith(t, CreateConfig(), req)
}

func serveWith(t *testing.T, cfg *Config, req *http.Request) seen {
	t.Helper()
	var got seen
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = seen{r.RemoteAddr, r.Header.Get("X-Real-Ip"), r.Header.Get("X-Forwarded-For"), r.Header.Get("CF-Connecting-IP"),
			r.Header.Get("X-Edge-Claimed-Ip"), r.Header.Get("True-Client-IP"), r.Header.Get("AR-Real-IP")}
	})
	h, err := New(context.Background(), next, cfg, "edge-client-ip")
	if err != nil {
		t.Fatal(err)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return got
}

// A request from a Cloudflare edge, which always sets CF-Connecting-IP.
func fromEdge(claimed string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "https://panel.example.test/", nil)
	req.RemoteAddr = "172.70.1.2:40000"
	req.Header.Set("X-Real-Ip", "172.70.1.2")
	req.Header.Set("CF-Connecting-IP", claimed)
	return req
}

func verified(req *http.Request) *http.Request {
	req.TLS = &tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{{{}}}}
	return req
}

func TestAVerifiedPullCarriesTheVisitorsAddress(t *testing.T) {
	got := serve(t, verified(fromEdge("5.6.7.8")))
	if got.remoteAddr != "5.6.7.8:40000" || got.realIP != "5.6.7.8" {
		t.Fatalf("verified pull: got %+v, want the visitor 5.6.7.8", got)
	}
	if got.cfConnectingIP != "" {
		t.Fatalf("CF-Connecting-IP must not reach a service, got %q", got.cfConnectingIP)
	}
}

func TestAnIPv6VisitorIsBracketedInTheSocketAddress(t *testing.T) {
	got := serve(t, verified(fromEdge("2001:db8::1")))
	if got.remoteAddr != "[2001:db8::1]:40000" || got.realIP != "2001:db8::1" {
		t.Fatalf("got %+v", got)
	}
}

// Anyone can send the header; without a verified chain it is a claim.
func TestTheHeaderIsIgnoredWithoutAVerifiedChain(t *testing.T) {
	for name, req := range map[string]*http.Request{
		"plain http":           fromEdge("5.6.7.8"),
		"tls, no client chain": func() *http.Request { r := fromEdge("5.6.7.8"); r.TLS = &tls.ConnectionState{}; return r }(),
	} {
		got := serve(t, req)
		if got.remoteAddr != "172.70.1.2:40000" || got.realIP != "172.70.1.2" || got.cfConnectingIP != "" {
			t.Fatalf("%s: got %+v, want the socket address and the header dropped", name, got)
		}
	}
}

func TestAMalformedClaimLeavesTheSocketAddress(t *testing.T) {
	for _, claimed := range []string{"", "not-an-ip", "5.6.7.8, 9.9.9.9", "5.6.7.8:80"} {
		got := serve(t, verified(fromEdge(claimed)))
		if got.remoteAddr != "172.70.1.2:40000" || got.realIP != "172.70.1.2" || got.cfConnectingIP != "" {
			t.Fatalf("claim %q: got %+v", claimed, got)
		}
	}
}

// Traefik drops X-Forwarded-For from a sender outside trustedIPs; the proxy
// then writes it from RemoteAddr. One left over must not outrank the visitor.
func TestAForwardedForLeftOnAVerifiedPullIsDropped(t *testing.T) {
	req := verified(fromEdge("5.6.7.8"))
	req.Header.Set("X-Forwarded-For", "1.1.1.1")
	if got := serve(t, req); got.forwardedFor != "" {
		t.Fatalf("got X-Forwarded-For %q", got.forwardedFor)
	}
}

// Behind a reseller's own CDN, Cloudflare's visitor is that CDN's edge, and the
// CDN names the person in a header of its own (ADR-0129 amendment 2).
func behindCDN(edge string, headers map[string]string) *http.Request {
	req := verified(fromEdge(edge))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return req
}

func TestACDNsClaimIsForwardedBesideTheVerifiedAddress(t *testing.T) {
	got := serve(t, behindCDN("185.215.232.193", map[string]string{"AR-Real-IP": "104.248.193.151"}))
	if got.realIP != "185.215.232.193" || got.claimed != "104.248.193.151" {
		t.Fatalf("got %+v: the address stays the edge, the claim rides beside it", got)
	}
	if got.arRealIP != "" {
		t.Fatalf("the CDN's own header must not reach a service, got %q", got.arRealIP)
	}
}

func TestTheFirstListedHeaderWins(t *testing.T) {
	got := serve(t, behindCDN("185.215.232.193", map[string]string{"True-Client-IP": "1.1.1.1", "AR-Real-IP": "2.2.2.2"}))
	if got.claimed != "1.1.1.1" || got.trueClientIP != "" || got.arRealIP != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestTheHeaderListIsConfigured(t *testing.T) {
	cfg := &Config{ClaimHeaders: []string{"X-Cdn-Visitor"}}
	got := serveWith(t, cfg, behindCDN("185.215.232.193", map[string]string{"X-Cdn-Visitor": "3.3.3.3", "AR-Real-IP": "2.2.2.2"}))
	if got.claimed != "3.3.3.3" {
		t.Fatalf("got %+v", got)
	}
}

func TestNoClaimWhenItIsNotAnAddressOrIsTheVisitorItself(t *testing.T) {
	for _, claim := range []string{"", "nope", "1.1.1.1, 2.2.2.2", "185.215.232.193"} {
		if got := serve(t, behindCDN("185.215.232.193", map[string]string{"True-Client-IP": claim})); got.claimed != "" {
			t.Fatalf("claim %q: got %+v", claim, got)
		}
	}
}

// A client cannot write the claim itself, nor make one without a verified pull.
func TestAClaimIsOnlyEverTheGatewaysOwn(t *testing.T) {
	forged := fromEdge("5.6.7.8")
	forged.Header.Set("X-Edge-Claimed-Ip", "9.9.9.9")
	forged.Header.Set("True-Client-IP", "9.9.9.9")
	if got := serve(t, forged); got.claimed != "" || got.trueClientIP != "" {
		t.Fatalf("unverified: got %+v", got)
	}
	direct := verified(fromEdge("5.6.7.8"))
	direct.Header.Set("X-Edge-Claimed-Ip", "9.9.9.9")
	if got := serve(t, direct); got.claimed != "" {
		t.Fatalf("verified, no CDN header: got %+v", got)
	}
}
