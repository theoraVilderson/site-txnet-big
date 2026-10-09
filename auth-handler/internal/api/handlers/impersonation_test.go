package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// The fixture is the contract (ADR-0136): this copy, shared-core's and the
// file must name exactly the same rows, the way wire.json is held (ADR-0036).
const impersonationFixturePath = "../../../../contracts/http/impersonation.json"

func callAs(t *testing.T, h *Handler, token, method, uri string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Forwarded-Method", method)
	if uri != "" {
		r.Header.Set("X-Forwarded-Uri", uri)
	}
	w := httptest.NewRecorder()
	h.Validate(w, r)
	return w
}

func impersonatedToken(t *testing.T) string {
	t.Helper()
	return sign(t, validClaims(map[string]any{"isImpersonated": true, "impersonatedBy": "support-7"}), testSecret)
}

func TestContractImpersonationReachIsTheFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(impersonationFixturePath))
	if err != nil {
		t.Fatalf("impersonation fixture %s is missing: %v", impersonationFixturePath, err)
	}
	var fixture struct {
		Allow []impersonationRoute `json:"allow"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("impersonation fixture: %v", err)
	}
	if len(fixture.Allow) != len(impersonationReach) {
		t.Fatalf("impersonationReach has %d rows, the fixture %d — update impersonation.go from %s",
			len(impersonationReach), len(fixture.Allow), impersonationFixturePath)
	}
	for i, row := range fixture.Allow {
		if impersonationReach[i] != row {
			t.Errorf("row %d: impersonationReach = %+v, fixture = %+v", i, impersonationReach[i], row)
		}
	}
}

// AC-1-g (§3.6 layer 4): an impersonated token reaches only what is listed.
// Everything else — the forbidden categories and every route nobody listed —
// is a 403 whose reason the panel reads, never a refresh or a sign-in.
func TestValidateKeepsAnImpersonatedTokenToItsAllowList(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	token := impersonatedToken(t)

	for _, c := range []struct{ method, uri string }{
		{http.MethodGet, "/api/billing/offers"},
		{http.MethodPost, "/api/billing/invoices/inv-1/pay"},
		{http.MethodGet, "/api/support/conversations/c-1/messages?before=10"},
		{http.MethodPut, "/api/billing/traffic/grants/g-1/cap"},
		{http.MethodGet, "/realtime"},
	} {
		if w := callAs(t, h, token, c.method, c.uri); w.Code != http.StatusOK {
			t.Errorf("%s %s: status = %d, want 200 (body %q)", c.method, c.uri, w.Code, w.Body.String())
		}
	}

	for _, c := range []struct{ method, uri string }{
		{http.MethodGet, "/api/billing/gateways"},                          // gateways
		{http.MethodPost, "/api/billing/tenant-wallets/t-1/adjustments"},   // wallet manual adjust
		{http.MethodGet, "/api/billing/gift/grants/g-1/subscription-link"}, // credentials
		{http.MethodPost, "/api/tenant-packages"},                          // plans
		{http.MethodPut, "/api/ai/admin/settings"},                         // AI provider
		{http.MethodGet, "/api/billing/brand-new-route"},                   // nobody listed it
		{http.MethodDelete, "/api/billing/offers"},                         // listed path, other method
		{http.MethodGet, "/api/billing/invoices/inv-1/extra"},              // deeper than listed
		{http.MethodGet, "/api/billing/invoices/../gateways"},
		{http.MethodGet, "/api/billing/invoices/%2e%2e/gateways"},
		{http.MethodGet, "/api/billing//invoices"},
		{http.MethodGet, ""}, // no forwarded URI: nothing to admit it on
	} {
		w := callAs(t, h, token, c.method, c.uri)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s %q: status = %d, want 403", c.method, c.uri, w.Code)
			continue
		}
		errObj, _ := decode(t, w)["error"].(map[string]any)
		if errObj["reason"] != reasonImpersonationBlocked {
			t.Errorf("%s %q: error = %v, want reason %q", c.method, c.uri, errObj, reasonImpersonationBlocked)
		}
	}
}

func TestValidateLeavesAnOwnTokenOffTheImpersonationList(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	own := sign(t, validClaims(nil), testSecret)

	if w := callAs(t, h, own, http.MethodGet, "/api/billing/gateways"); w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
}
