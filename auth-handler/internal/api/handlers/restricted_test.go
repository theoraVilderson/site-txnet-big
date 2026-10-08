package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// callAt runs Validate as Traefik does: the request the gate is asked about
// arrives as X-Forwarded-Method / X-Forwarded-Uri.
func callAt(t *testing.T, h *Handler, token, uri string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	if uri != "" {
		r.Header.Set("X-Forwarded-Method", http.MethodGet)
		r.Header.Set("X-Forwarded-Uri", uri)
	}
	w := httptest.NewRecorder()
	h.Validate(w, r)
	return w
}

// BAN-1-c (ADR-0133 decision 4): a restricted account's token reaches its own
// support conversations and the socket, and nothing else. Every other path is
// a 403 whose `error.reason` tells the panel to draw the restricted screen
// rather than to refresh or sign in again.
func TestValidateKeepsARestrictedTokenToItsAllowList(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	restricted := sign(t, validClaims(map[string]any{"restricted": true, "permissions": []string{}}), testSecret)

	for _, uri := range []string{
		"/api/support/conversations",
		"/api/support/conversations/c-1/messages?before=10",
		"/api/support/categories",
		"/api/support/availability",
		"/realtime",
	} {
		if w := callAt(t, h, restricted, uri); w.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200 (body %q)", uri, w.Code, w.Body.String())
		}
	}

	for _, uri := range []string{
		"/api/billing/wallet",
		"/api/support/agent/conversations",
		"/api/support/settings",
		"/api/support/conversationsX",
		"/api/support/conversations/../agent/conversations",
		"/api/support/conversations/%2e%2e/agent",
		"", // no forwarded URI: nothing to admit it on
	} {
		w := callAt(t, h, restricted, uri)
		if w.Code != http.StatusForbidden {
			t.Errorf("%q: status = %d, want 403", uri, w.Code)
			continue
		}
		body := decode(t, w)
		errObj, _ := body["error"].(map[string]any)
		if errObj["reason"] != reasonAccountRestricted {
			t.Errorf("%q: error = %v, want reason %q", uri, body["error"], reasonAccountRestricted)
		}
	}
}

func TestValidateLeavesAnUnrestrictedTokenAlone(t *testing.T) {
	h, _ := newHandler(t, sessionActive, testEngine(t))
	whole := sign(t, validClaims(nil), testSecret)

	if w := callAt(t, h, whole, "/api/billing/wallet"); w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
}
