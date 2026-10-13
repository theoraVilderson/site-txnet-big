package middlewares

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"auth-handler/pkg/logger"
)

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// serve runs RequestID with the given inbound id and reports the id the
// handler saw in its context and the one the response carried — the one
// Traefik copies onto the upstream request (authResponseHeaders).
func serve(t *testing.T, inbound string) (seen, answered string) {
	t.Helper()
	h := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = logger.RequestID(r.Context())
		w.WriteHeader(http.StatusUnauthorized)
	}))
	req := httptest.NewRequest(http.MethodGet, "/validate", nil)
	if inbound != "" {
		req.Header.Set(HeaderRequestID, inbound)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return seen, rec.Header().Get(HeaderRequestID)
}

// H13: the caller's id is kept when it is 8–128 characters of [A-Za-z0-9-] —
// the rule shared-core's acceptRequestId holds on the Node side.
func TestRequestIDKeepsAnIDThatFitsTheRule(t *testing.T) {
	for _, id := range []string{"trace-0001", strings.Repeat("a", 128)} {
		seen, answered := serve(t, id)
		if seen != id || answered != id {
			t.Errorf("id %q: handler saw %q, response carried %q", id, seen, answered)
		}
	}
}

// A refused answer carries the id too, so a 401 can be quoted back.
func TestRequestIDMintsOneForAMissingOrUnsafeID(t *testing.T) {
	for _, id := range []string{"", "short", strings.Repeat("a", 129), "abc def ghi", "id\n{\"level\":\"ERROR\"}"} {
		seen, answered := serve(t, id)
		if !uuidV4.MatchString(seen) || answered != seen {
			t.Errorf("id %q: handler saw %q, response carried %q — want one new UUID v4", id, seen, answered)
		}
	}
}
