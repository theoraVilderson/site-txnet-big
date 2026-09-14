package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// A refusal from this gate is what the browser reads when a panel call is
// blocked: Traefik hands the ForwardAuth answer to the client as it is. With no
// CORS headers on it the browser hides the 401, the panel cannot see that the
// token expired, and its refresh-and-retry never runs — the call reads as a
// CORS failure instead of "sign in again" (SURFACES `billing-calls-never-reach-the-server`).
//
// A 2xx is never touched: Traefik throws its body away and forwards only
// `authResponseHeaders`, and the upstream service sets its own CORS headers.
func TestRefusalCarriesCORSForAllowedOrigin(t *testing.T) {
	h, _ := newHandler(t, sessionActive, nil)
	h = h.WithCORSOrigins([]string{"https://panel.example.test", " https://other.example.test "})

	cases := []struct {
		name, origin string
		wantAllow    string
	}{
		{"allowed origin", "https://panel.example.test", "https://panel.example.test"},
		{"allowed origin, trimmed from config", "https://other.example.test", "https://other.example.test"},
		{"unknown origin", "https://evil.example.test", ""},
		{"no origin", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPatch, "/validate", nil)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			h.Validate(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", w.Code)
			}
			if got := w.Header().Get("Access-Control-Allow-Origin"); got != tc.wantAllow {
				t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, tc.wantAllow)
			}
			wantCreds := ""
			if tc.wantAllow != "" {
				wantCreds = "true"
			}
			if got := w.Header().Get("Access-Control-Allow-Credentials"); got != wantCreds {
				t.Fatalf("Access-Control-Allow-Credentials = %q, want %q", got, wantCreds)
			}
			if tc.origin != "" && w.Header().Get("Vary") != "Origin" {
				t.Fatalf("Vary = %q, want Origin", w.Header().Get("Vary"))
			}
		})
	}
}

func TestSuccessCarriesNoCORS(t *testing.T) {
	h, _ := newHandler(t, sessionActive, nil)
	h = h.WithCORSOrigins([]string{"https://panel.example.test"})
	r := httptest.NewRequest(http.MethodGet, "/validate", nil)
	r.Header.Set("Authorization", "Bearer "+sign(t, validClaims(nil), testSecret))
	r.Header.Set("Origin", "https://panel.example.test")
	w := httptest.NewRecorder()
	h.Validate(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("a 2xx must not carry CORS headers, got %q", got)
	}
}
