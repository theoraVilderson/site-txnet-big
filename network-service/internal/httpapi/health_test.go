package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakeDB struct{ err error }

func (f fakeDB) Ping(ctx context.Context) error { return f.err }

func discardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func call(t *testing.T, db Pinger) (int, healthResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	New(db, discardLogger()).Health(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	var body healthResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	return rec.Code, body
}

func TestHealthIsOkWhenTheDatabaseAnswers(t *testing.T) {
	code, body := call(t, fakeDB{})

	if code != http.StatusOK {
		t.Errorf("status = %d, want 200", code)
	}
	if body.Status != "ok" || body.Checks["database"] != "ok" {
		t.Errorf("body = %+v, want an ok database", body)
	}
}

// A process that cannot reach its database cannot collect anything, so it says
// so rather than reporting healthy and metering nothing.
func TestHealthIsUnavailableWhenTheDatabaseIsUnreachable(t *testing.T) {
	code, body := call(t, fakeDB{err: errors.New("connection refused")})

	if code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", code)
	}
	if body.Status != "degraded" || body.Checks["database"] != "unreachable" {
		t.Errorf("body = %+v, want a degraded database", body)
	}
}
