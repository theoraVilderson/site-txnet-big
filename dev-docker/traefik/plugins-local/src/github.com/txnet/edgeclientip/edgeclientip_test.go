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
		"plain http":           func() *http.Request { r := fromEdge("5.6.7.8"); r.TLS = nil; return r }(),
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

// headersAfter is every header the next handler receives.
func headersAfter(t *testing.T, req *http.Request) (http.Header, string) {
	t.Helper()
	var got http.Header
	var remote string
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got, remote = r.Header.Clone(), r.RemoteAddr })
	h, err := New(context.Background(), next, CreateConfig(), "edge-client-ip")
	if err != nil {
		t.Fatal(err)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return got, remote
}

// A CDN with no header of its own appends the visitor to X-Forwarded-For, and
// Cloudflare appends that CDN's edge after it (EDGE-1-m).
func TestWithNoCDNHeaderTheClaimIsTheEntryBeforeTheEdge(t *testing.T) {
	req := behindCDN("185.215.232.193", map[string]string{"X-Forwarded-For": "6.6.6.6, 104.248.193.151, 185.215.232.193"})
	if got := serve(t, req); got.claimed != "104.248.193.151" || got.forwardedFor != "" {
		t.Fatalf("got %+v", got)
	}
}

func TestACDNsOwnHeaderOutranksXForwardedFor(t *testing.T) {
	req := behindCDN("185.215.232.193", map[string]string{"AR-Real-IP": "2.2.2.2", "X-Forwarded-For": "1.1.1.1, 185.215.232.193"})
	if got := serve(t, req); got.claimed != "2.2.2.2" {
		t.Fatalf("got %+v", got)
	}
}

func TestXForwardedForAcrossHeaderLinesIsOneList(t *testing.T) {
	req := behindCDN("185.215.232.193", nil)
	req.Header.Add("X-Forwarded-For", "104.248.193.151")
	req.Header.Add("X-Forwarded-For", "185.215.232.193")
	if got := serve(t, req); got.claimed != "104.248.193.151" {
		t.Fatalf("got %+v", got)
	}
}

// Only a list Cloudflare ended with the edge it saw is read; anything else
// is not the shape a CDN in front of Cloudflare leaves.
func TestNoClaimFromAnXForwardedForCloudflareDidNotEnd(t *testing.T) {
	for _, xff := range []string{"185.215.232.193", "104.248.193.151, 9.9.9.9", "nope, 185.215.232.193", ", 185.215.232.193"} {
		if got := serve(t, behindCDN("185.215.232.193", map[string]string{"X-Forwarded-For": xff})); got.claimed != "" {
			t.Fatalf("xff %q: got %+v", xff, got)
		}
	}
	unverified := fromEdge("185.215.232.193")
	unverified.Header.Set("X-Forwarded-For", "104.248.193.151, 185.215.232.193")
	if got := serve(t, unverified); got.claimed != "" || got.forwardedFor != "" {
		t.Fatalf("unverified: got %+v", got)
	}
}

func TestCloudFrontsAddressCarriesAPort(t *testing.T) {
	for in, want := range map[string]string{"104.248.193.151:51234": "104.248.193.151", "2001:db8::7:51234": "2001:db8::7"} {
		got := serve(t, behindCDN("185.215.232.193", map[string]string{"CloudFront-Viewer-Address": in}))
		if got.claimed != want {
			t.Fatalf("%q: got %+v", in, got)
		}
	}
}

// The gateway's entrypoint keeps every forwarded header so the plugin can read
// X-Forwarded-For; the plugin then rewrites them all from the request itself.
// A client's X-Forwarded-Host would otherwise pick the tenant (EDGE-1-m).
func TestEveryForwardedHeaderIsTheGatewaysOwn(t *testing.T) {
	forge := func(r *http.Request) *http.Request {
		r.Host = "panel.example.test"
		for k, v := range map[string]string{
			"X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http", "X-Forwarded-Port": "1",
			"X-Forwarded-Server": "x", "X-Forwarded-Prefix": "/x", "X-Forwarded-Uri": "/x", "X-Forwarded-Method": "DELETE",
			"X-Forwarded-Tls-Client-Cert": "x", "X-Forwarded-Tls-Client-Cert-Info": "x", "X-Real-Ip": "9.9.9.9",
		} {
			r.Header.Set(k, v)
		}
		return r
	}
	cases := map[string]struct {
		req                 *http.Request
		proto, port, realIP string
	}{
		"verified":      {forge(verified(fromEdge("5.6.7.8"))), "https", "443", "5.6.7.8"},
		"plain http":    {func() *http.Request { r := forge(fromEdge("5.6.7.8")); r.TLS = nil; return r }(), "http", "80", "172.70.1.2"},
		"tls, no chain": {func() *http.Request { r := forge(fromEdge("5.6.7.8")); r.TLS = &tls.ConnectionState{}; return r }(), "https", "443", "172.70.1.2"},
	}
	for name, c := range cases {
		h, _ := headersAfter(t, c.req)
		want := map[string]string{"X-Forwarded-Host": "panel.example.test", "X-Forwarded-Proto": c.proto, "X-Forwarded-Port": c.port, "X-Real-Ip": c.realIP}
		for k, v := range want {
			if h.Get(k) != v {
				t.Fatalf("%s: %s = %q, want %q", name, k, h.Get(k), v)
			}
		}
		for _, k := range []string{"X-Forwarded-Server", "X-Forwarded-Prefix", "X-Forwarded-Uri", "X-Forwarded-Method",
			"X-Forwarded-Tls-Client-Cert", "X-Forwarded-Tls-Client-Cert-Info", "X-Forwarded-For"} {
			if h.Get(k) != "" {
				t.Fatalf("%s: %s survived as %q", name, k, h.Get(k))
			}
		}
	}
}

func TestAHostWithAPortAndAWebSocketKeepTraefiksSpelling(t *testing.T) {
	req := verified(fromEdge("5.6.7.8"))
	req.Host = "panel.example.test:8443"
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	h, _ := headersAfter(t, req)
	if h.Get("X-Forwarded-Proto") != "wss" || h.Get("X-Forwarded-Port") != "8443" || h.Get("X-Forwarded-Host") != "panel.example.test:8443" {
		t.Fatalf("got %v", h)
	}
}

// NIN-1-b2/-b3: the domestic door's Traefik is reached only from the approved
// edges' ranges (hosting O7, O12), and its edge names the visitor in a header
// it overwrites — Arvan's X-Real-IP (NIN-1-a). No certificate exists there.
func domestic() *Config { return &Config{VisitorHeader: "X-Real-IP"} }

func fromArvan(headers map[string]string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "https://shop.reseller.ir/", nil)
	req.RemoteAddr = "94.101.182.2:41000"
	req.TLS = &tls.ConnectionState{}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return req
}

func TestOnTheDomesticDoorTheEdgesHeaderIsTheVisitor(t *testing.T) {
	got := serveWith(t, domestic(), fromArvan(map[string]string{"X-Real-IP": "5.6.7.8"}))
	if got.remoteAddr != "5.6.7.8:41000" || got.realIP != "5.6.7.8" {
		t.Fatalf("got %+v, want the visitor 5.6.7.8", got)
	}
	got = serveWith(t, domestic(), fromArvan(map[string]string{"X-Real-IP": "2001:db8::7"}))
	if got.remoteAddr != "[2001:db8::7]:41000" {
		t.Fatalf("IPv6 visitor: got %+v", got)
	}
}

// Arvan keeps a client's X-Forwarded-For and appends to it, and passes any
// header it does not set: none of those may name the visitor here.
func TestOnTheDomesticDoorNothingAClientCanSetIsRead(t *testing.T) {
	got := serveWith(t, domestic(), fromArvan(map[string]string{
		"X-Real-IP":         "5.6.7.8",
		"X-Forwarded-For":   "6.6.6.6, 5.6.7.8",
		"CF-Connecting-IP":  "7.7.7.7",
		"True-Client-IP":    "8.8.8.8",
		"X-Edge-Claimed-Ip": "9.9.9.9",
	}))
	if got.remoteAddr != "5.6.7.8:41000" || got.forwardedFor != "" || got.cfConnectingIP != "" ||
		got.claimed != "" || got.trueClientIP != "" {
		t.Fatalf("got %+v, want only the edge's header read and every other one dropped", got)
	}
}

// CF-Connecting-IP never counts here, even with a verified chain: this door's
// proof is the ranges, and its own edge's header is the only name it trusts.
func TestOnTheDomesticDoorCloudflaresHeaderNeverCounts(t *testing.T) {
	req := verified(fromArvan(map[string]string{"CF-Connecting-IP": "7.7.7.7"}))
	if got := serveWith(t, domestic(), req); got.remoteAddr != "94.101.182.2:41000" || got.realIP != "94.101.182.2" {
		t.Fatalf("got %+v, want the socket address", got)
	}
}

func TestOnTheDomesticDoorAMissingOrMalformedHeaderLeavesTheSocket(t *testing.T) {
	for _, value := range []string{"", "not-an-ip", "5.6.7.8, 6.6.6.6", "5.6.7.8:443"} {
		got := serveWith(t, domestic(), fromArvan(map[string]string{"X-Real-IP": value}))
		if got.remoteAddr != "94.101.182.2:41000" || got.realIP != "94.101.182.2" {
			t.Fatalf("%q: got %+v, want the edge's own address", value, got)
		}
	}
}

// NIN-1-e2: the door a request came through is the gateway's to say, so the
// domain check can tell an approved edge (only its ranges reach the domestic
// door, hosting O7) from Cloudflare or a caller with no edge at all.
func doorAfter(t *testing.T, cfg *Config, req *http.Request) string {
	t.Helper()
	var door string
	next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { door = r.Header.Get("X-Edge-Door") })
	h, err := New(context.Background(), next, cfg, "edge-client-ip")
	if err != nil {
		t.Fatal(err)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return door
}

func TestEachDoorNamesItselfAndAClientCannotNameOne(t *testing.T) {
	forged := func(req *http.Request) *http.Request { req.Header.Set("X-Edge-Door", "domestic"); return req }
	cases := []struct {
		name string
		cfg  *Config
		req  *http.Request
		want string
	}{
		{"verified pull", CreateConfig(), forged(verified(fromEdge("5.6.7.8"))), "cloudflare"},
		{"no certificate on 443", CreateConfig(), forged(fromEdge("5.6.7.8")), "direct"},
		{"the domestic door", domestic(), fromArvan(map[string]string{"X-Edge-Door": "cloudflare"}), "domestic"},
	}
	for _, c := range cases {
		if got := doorAfter(t, c.cfg, c.req); got != c.want {
			t.Errorf("%s: X-Edge-Door = %q, want %q", c.name, got, c.want)
		}
	}
}
