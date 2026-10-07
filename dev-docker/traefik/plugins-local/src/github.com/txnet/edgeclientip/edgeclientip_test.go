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
	remoteAddr, realIP, forwardedFor, cfConnectingIP string
}

func serve(t *testing.T, req *http.Request) seen {
	t.Helper()
	var got seen
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = seen{r.RemoteAddr, r.Header.Get("X-Real-Ip"), r.Header.Get("X-Forwarded-For"), r.Header.Get("CF-Connecting-IP")}
	})
	h, err := New(context.Background(), next, CreateConfig(), "edge-client-ip")
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
