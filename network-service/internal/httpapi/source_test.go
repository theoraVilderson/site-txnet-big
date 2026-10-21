package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"network-service/internal/egress"
	"network-service/internal/opener"
	"network-service/internal/source"
)

type logins struct {
	login string
	err   error
}

func (l logins) SourceLogin(context.Context, string, string) (string, error) { return l.login, l.err }

func sourceServer(l logins, token string) *http.ServeMux {
	mux := http.NewServeMux()
	(&Source{Logins: l, HTTP: source.HTTPClient(egress.Guard{}), ServiceToken: token,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}).Register(mux)
	return mux
}

func post(mux *http.ServeMux, token, body string) (int, string) {
	req := httptest.NewRequest(http.MethodPost, "/api/internal/source/snapshot", strings.NewReader(body))
	req.Header.Set(opener.ServiceTokenHeader, token)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var got struct {
		Error struct {
			Reason string `json:"reason"`
		} `json:"error"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&got)
	return rec.Code, got.Error.Reason
}

const marzbanAt = `{"tenantId":"t1","family":"marzban","apiBaseUrl":"%s","credentialRef":"ref-1"}`

func TestSourceRoutesAreServiceOnly(t *testing.T) {
	body := strings.Replace(marzbanAt, "%s", "https://old.example", 1)
	for _, tc := range []struct{ configured, sent string }{{"tok", "wrong"}, {"tok", ""}, {"", ""}} {
		if code, reason := post(sourceServer(logins{}, tc.configured), tc.sent, body); code != http.StatusForbidden || reason != "service_only" {
			t.Errorf("configured %q, sent %q: %d %s, want 403 service_only", tc.configured, tc.sent, code, reason)
		}
	}
}

func TestSourceSnapshotRefusesWhatItCannotRead(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		logins     logins
		code       int
		reason     string
	}{
		{"not an import family", `{"tenantId":"t1","family":"mikrotik_user_manager","apiBaseUrl":"https://h","credentialRef":"r"}`,
			logins{login: "a:b"}, http.StatusBadRequest, "bad_request"},
		{"the vault refuses", strings.Replace(marzbanAt, "%s", "https://old.example", 1),
			logins{err: errors.New("not_owner")}, http.StatusUnprocessableEntity, "credential_unavailable"},
		// The source is a tenant's choice: the bare guard refuses an inward address.
		{"an inward address", strings.Replace(marzbanAt, "%s", "http://127.0.0.1:9", 1),
			logins{login: "admin:secret"}, http.StatusUnprocessableEntity, "address_refused"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code, reason := post(sourceServer(tc.logins, "tok"), "tok", tc.body); code != tc.code || reason != tc.reason {
				t.Fatalf("%d %s, want %d %s", code, reason, tc.code, tc.reason)
			}
		})
	}
}
