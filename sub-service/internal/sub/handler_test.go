package sub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The invariant this row turns on (F-113-a, catalog C-16): a subscription
// token answers only on a `purpose = subscription` domain the Grant's own
// tenant may serve from, and the answer never carries a cookie or a CORS
// grant. Every other combination is the same neutral 404, so the endpoint
// cannot be used to learn whether a token exists on some other tenant.

const (
	tenantA = "11111111-1111-1111-1111-111111111111"
	tenantB = "22222222-2222-2222-2222-222222222222"
	token   = "tok_abcdefghijklmnopqrstuvwxyz012345"
)

type fakeStore struct {
	domains map[string]Domain
	grants  map[string]Grant
	err     error
	// hashes records what the store was asked for, so a test can prove the
	// raw token never reached it.
	hashes []string
}

func (f *fakeStore) DomainByHost(_ context.Context, host string) (Domain, bool, error) {
	if f.err != nil {
		return Domain{}, false, f.err
	}
	d, ok := f.domains[host]
	return d, ok, nil
}

func (f *fakeStore) GrantByTokenHash(_ context.Context, hash string) (Grant, bool, error) {
	f.hashes = append(f.hashes, hash)
	if f.err != nil {
		return Grant{}, false, f.err
	}
	g, ok := f.grants[hash]
	return g, ok, nil
}

func hashOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func newStore() *fakeStore {
	return &fakeStore{
		domains: map[string]Domain{
			"sub.alpha.com":      {TenantID: tenantA, Purpose: "subscription", DomainType: "custom_domain", VerificationStatus: "verified"},
			"alpha-sub.txnet.io": {TenantID: tenantA, Purpose: "subscription", DomainType: "subdomain", VerificationStatus: "pending"},
			"panel.alpha.com":    {TenantID: tenantA, Purpose: "panel", DomainType: "custom_domain", VerificationStatus: "verified"},
			"cdn.alpha.com":      {TenantID: tenantA, Purpose: "assets", DomainType: "custom_domain", VerificationStatus: "verified"},
			"unproven.alpha.com": {TenantID: tenantA, Purpose: "subscription", DomainType: "custom_domain", VerificationStatus: "pending"},
			"sub.beta.com":       {TenantID: tenantB, Purpose: "subscription", DomainType: "custom_domain", VerificationStatus: "verified"},
		},
		grants: map[string]Grant{
			hashOf(token): {ID: "g-1", TenantID: tenantA, Status: "active"},
		},
	}
}

func serve(t *testing.T, store Store, method, host, path string) *http.Response {
	t.Helper()
	mux := http.NewServeMux()
	New(store, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(mux)
	req := httptest.NewRequest(method, path, nil)
	req.Host = host
	req.Header.Set("Origin", "https://panel.alpha.com")
	req.Header.Set("Cookie", "txnet_session=abc")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec.Result()
}

func assertNoCookieNoCORS(t *testing.T, res *http.Response) {
	t.Helper()
	if v := res.Header.Values("Set-Cookie"); len(v) != 0 {
		t.Errorf("Set-Cookie = %v, want none (C-16)", v)
	}
	for name := range res.Header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			t.Errorf("%s set, want no CORS header at all (C-16)", name)
		}
	}
}

func TestServesOnlyOnTheGrantTenantsSubscriptionDomain(t *testing.T) {
	cases := []struct {
		name string
		host string
		want int
	}{
		{"verified custom subscription domain", "sub.alpha.com", http.StatusOK},
		{"platform subdomain needs no verification", "alpha-sub.txnet.io", http.StatusOK},
		{"host normalised: case, port, root dot", "SUB.Alpha.com.:443", http.StatusOK},
		{"the tenant's panel domain", "panel.alpha.com", http.StatusNotFound},
		{"the tenant's assets domain", "cdn.alpha.com", http.StatusNotFound},
		{"an unverified custom domain", "unproven.alpha.com", http.StatusNotFound},
		{"another tenant's subscription domain", "sub.beta.com", http.StatusNotFound},
		{"a host nobody owns", "evil.example", http.StatusNotFound},
		{"no host", "", http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := serve(t, newStore(), http.MethodGet, tc.host, "/sub/"+token)
			if res.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", res.StatusCode, tc.want)
			}
			assertNoCookieNoCORS(t, res)
		})
	}
}

func TestUnknownTokenIsTheSameNeutral404(t *testing.T) {
	onOwn := serve(t, newStore(), http.MethodGet, "sub.alpha.com", "/sub/not-a-token")
	onOther := serve(t, newStore(), http.MethodGet, "sub.beta.com", "/sub/"+token)
	a, _ := io.ReadAll(onOwn.Body)
	b, _ := io.ReadAll(onOther.Body)
	if onOwn.StatusCode != http.StatusNotFound || onOther.StatusCode != http.StatusNotFound {
		t.Fatalf("statuses = %d, %d, want 404, 404", onOwn.StatusCode, onOther.StatusCode)
	}
	if string(a) != string(b) {
		t.Fatalf("bodies differ (%q vs %q): an unknown token and a foreign one must read alike", a, b)
	}
}

func TestTokenIsLookedUpByItsSHA256Only(t *testing.T) {
	store := newStore()
	serve(t, store, http.MethodGet, "sub.alpha.com", "/sub/"+token)
	if len(store.hashes) != 1 || store.hashes[0] != hashOf(token) {
		t.Fatalf("store asked for %v, want exactly [sha256(token)]", store.hashes)
	}
}

func TestStoreFailureIs503NotA404(t *testing.T) {
	store := newStore()
	store.err = errors.New("connection refused")
	res := serve(t, store, http.MethodGet, "sub.alpha.com", "/sub/"+token)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: a database outage must not read as a revoked link", res.StatusCode)
	}
	assertNoCookieNoCORS(t, res)
}

func TestAPreflightGetsNoCORSGrant(t *testing.T) {
	res := serve(t, newStore(), http.MethodOptions, "sub.alpha.com", "/sub/"+token)
	if res.StatusCode == http.StatusOK || res.StatusCode == http.StatusNoContent {
		t.Fatalf("OPTIONS answered %d, want a refusal: /sub has no CORS", res.StatusCode)
	}
	assertNoCookieNoCORS(t, res)
}

func TestOnlyTheOnePathSegmentIsAToken(t *testing.T) {
	for _, path := range []string{"/sub/", "/sub", "/sub/" + token + "/extra", "/"} {
		res := serve(t, newStore(), http.MethodGet, "sub.alpha.com", path)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, res.StatusCode)
		}
	}
}
