package egress

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestRefusesEveryInwardAddress(t *testing.T) {
	g := Guard{}
	for _, a := range []string{
		"127.0.0.1", "::1", "0.0.0.0", "::",
		"10.1.2.3", "172.16.0.1", "192.168.1.1", "fd00:ec2::254",
		"169.254.169.254", "fe80::1", // link-local: every cloud's metadata
		"100.100.100.200", // CGNAT range: Alibaba's metadata
		"::ffff:10.0.0.1", // an IPv4 private address in IPv6 clothing
		"64:ff9b::a00:1",  // NAT64 of 10.0.0.1
		"224.0.0.1", "255.255.255.255", "198.18.0.1",
	} {
		if err := g.check(netip.MustParseAddr(a)); !errors.Is(err, ErrRefused) {
			t.Errorf("%s: got %v, want ErrRefused", a, err)
		}
	}
	for _, a := range []string{"2.144.24.219", "8.8.8.8", "2606:4700::1111"} {
		if err := g.check(netip.MustParseAddr(a)); err != nil {
			t.Errorf("%s: refused a public address: %v", a, err)
		}
	}
}

func TestAllowOpensOnlyTheListedRange(t *testing.T) {
	g := Guard{Allow: []netip.Prefix{netip.MustParsePrefix("10.8.0.0/24")}}
	if err := g.check(netip.MustParseAddr("10.8.0.5")); err != nil {
		t.Fatalf("listed range refused: %v", err)
	}
	if err := g.check(netip.MustParseAddr("10.9.0.5")); !errors.Is(err, ErrRefused) {
		t.Fatalf("unlisted private address: got %v", err)
	}
	if err := g.check(netip.MustParseAddr("::ffff:10.8.0.5")); err != nil {
		t.Fatalf("the mapped form of a listed address refused: %v", err)
	}
}

func TestTheDialIsRefusedNotTheName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))

	// By name: "localhost" is resolved, and the address dialed is the one refused.
	_, err := Client(Guard{}).Get("http://localhost:" + port)
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("localhost: got %v, want ErrRefused", err)
	}
	// Allowed, the same server answers.
	resp, err := Client(Guard{Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}).Get(srv.URL)
	if err != nil {
		t.Fatalf("allowed: %v", err)
	}
	resp.Body.Close()
}

func TestTheProxyFromTheEnvironmentIsIgnored(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://8.8.8.8:3128")
	t.Setenv("http_proxy", "http://8.8.8.8:3128")
	if Client(Guard{}).Transport.(*bodyCap).next.(*http.Transport).Proxy != nil {
		t.Fatal("a proxy would be dialed instead of the panel, and the guard would check the proxy")
	}
}

func TestARedirectInwardIsRefused(t *testing.T) {
	// 127.0.0.2 is loopback too, and outside the one address allowed.
	ln, err := net.Listen("tcp", "127.0.0.2:0")
	if err != nil {
		t.Skipf("no 127.0.0.2 here: %v", err)
	}
	inner := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the inward address was reached")
	}))
	inner.Listener = ln
	inner.Start()
	defer inner.Close()
	outer := httptest.NewServer(http.RedirectHandler(inner.URL+"/latest/meta-data", http.StatusFound))
	defer outer.Close()

	_, err = Client(Guard{Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}}).Get(outer.URL)
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want ErrRefused", err)
	}
}

func TestTheBodyIsCapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := 100
		if r.URL.Path == "/big" {
			n = 101
		}
		_, _ = w.Write([]byte(strings.Repeat("x", n)))
	}))
	defer srv.Close()
	c := Client(Guard{Allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}, MaxBody: 100})

	read := func(path string) error {
		resp, err := c.Get(srv.URL + path)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		_, err = io.ReadAll(resp.Body)
		return err
	}
	if err := read("/"); err != nil {
		t.Fatalf("a body at the cap: %v", err)
	}
	if err := read("/big"); !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("a body past the cap: got %v, want ErrBodyTooLarge", err)
	}
}

func TestParseAllow(t *testing.T) {
	got, err := ParseAllow(" 10.8.0.0/24, fd12::/64 ,,")
	if err != nil || len(got) != 2 {
		t.Fatalf("got %v, %v", got, err)
	}
	if _, err := ParseAllow("10.8.0.1"); err == nil {
		t.Fatal("a bare address is not a range; it must be refused, not read as /32 or /0")
	}
}
