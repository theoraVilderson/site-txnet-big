package sub

import (
	"context"
	"net/http"
	"testing"
)

// F-203-b: a user imported from another panel keeps fetching the link that
// panel gave them, now on a `legacy_sub` host the reseller pointed here
// (F-204-a). What fails silently: the old link answered without the headers
// an app shows (quota, expiry, refresh), a trailing slash the old panel
// served refused, an old path answered on some other host, and the panel's
// own `/sub/{token}` stopping on the very host every user is on.

const (
	legacyHost  = "sub.ali-vpn.ir"
	legacyToken = "eyJzdWIiOiJhbGkifQ.c2ln"
)

type legacyStore struct {
	*fakeStore
	links map[string]Grant
}

func (s *legacyStore) GrantByLegacyPath(_ context.Context, tenantID, host, path string) (Grant, bool, error) {
	if s.err != nil {
		return Grant{}, false, s.err
	}
	g, ok := s.links[tenantID+"|"+host+"|"+path]
	return g, ok, nil
}

func newLegacyStore() *legacyStore {
	s := &legacyStore{fakeStore: newStore(), links: map[string]Grant{
		tenantA + "|" + legacyHost + "|/sub/" + legacyToken: {ID: "g-old", TenantID: tenantA, Status: "active"},
	}}
	s.domains[legacyHost] = Domain{TenantID: tenantA, Purpose: "legacy_sub", DomainType: "custom_domain", VerificationStatus: "verified"}
	s.domains["old.unproven.ir"] = Domain{TenantID: tenantA, Purpose: "legacy_sub", DomainType: "custom_domain", VerificationStatus: "pending"}
	return s
}

func TestALegacyHostAnswersTheOldLinkWithTheGrantsSubscription(t *testing.T) {
	for _, path := range []string{"/sub/" + legacyToken, "/sub/" + legacyToken + "/"} {
		res := serve(t, newLegacyStore(), http.MethodGet, legacyHost, path)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", path, res.StatusCode)
		}
		// The headers `/sub/{token}` carries, so the app keeps showing quota and expiry.
		for _, name := range []string{"Subscription-Userinfo", "Profile-Update-Interval"} {
			if res.Header.Get(name) == "" {
				t.Errorf("%s: no %s header", path, name)
			}
		}
		assertNoCookieNoCORS(t, res)
	}
}

func TestALegacyHostAnswersOnlyWhatItHolds(t *testing.T) {
	cases := []struct {
		name, host, path string
		want             int
	}{
		{"the panel's own token on the old host", legacyHost, "/sub/" + token, http.StatusOK},
		{"a path no import kept", legacyHost, "/sub/not-an-old-link", http.StatusNotFound},
		{"the old link on the tenant's subscription domain", "sub.alpha.com", "/sub/" + legacyToken, http.StatusNotFound},
		{"the old link on an unproven old host", "old.unproven.ir", "/sub/" + legacyToken, http.StatusNotFound},
		{"two segments on a subscription domain", "sub.alpha.com", "/sub/" + token + "/x", http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := serve(t, newLegacyStore(), http.MethodGet, tc.host, tc.path).StatusCode; got != tc.want {
				t.Fatalf("status = %d, want %d", got, tc.want)
			}
		})
	}
}

// A token is one segment: a longer path on a subscription domain is not looked up at all.
func TestALongerPathIsNoTokenLookup(t *testing.T) {
	s := newLegacyStore()
	serve(t, s, http.MethodGet, "sub.alpha.com", "/sub/"+token+"/x")
	if len(s.hashes) != 0 {
		t.Fatalf("looked up %d token hash(es), want none", len(s.hashes))
	}
}
