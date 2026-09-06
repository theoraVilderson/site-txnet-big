package locale

import (
	"io"
	"log/slog"
	"testing"
)

// A Store that has not connected to locale-service is not a broken Store —
// it is the state the gateway runs in whenever locale-service is down or
// still booting. Every method has to keep answering, because the alternative
// is that a translation outage takes authentication down with it. That is the
// only behaviour testable without a live gRPC server, and it is the one that
// matters at 3am.

func newTestStore(addr, scope, defaultLang string) *Store {
	return NewStore(addr, scope, defaultLang, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestNewStoreDefaultsScopeToBackend(t *testing.T) {
	if got := newTestStore("localhost:50051", "", "fa").scope; got != "backend" {
		t.Errorf("scope = %q, want %q", got, "backend")
	}
	if got := newTestStore("localhost:50051", "frontend", "fa").scope; got != "frontend" {
		t.Errorf("scope = %q, want the configured scope kept", got)
	}
}

func TestUnconnectedStoreFallsBackInsteadOfFailing(t *testing.T) {
	s := newTestStore("", "backend", "fa")

	if got := s.ResolveLanguage("en-US,en;q=0.9"); got != "fa" {
		t.Errorf("ResolveLanguage() = %q, want the default language %q", got, "fa")
	}
	if got := s.Translate("en", "messages", "session_revoked"); got != "session_revoked" {
		t.Errorf("Translate() = %q, want the key echoed back", got)
	}
	if got := s.TranslateWith("en", "messages", "greeting", map[string]string{"name": "Ada"}); got != "greeting" {
		t.Errorf("TranslateWith() = %q, want the key echoed back", got)
	}
	if got := s.GetAvailableLanguages(); got != nil {
		t.Errorf("GetAvailableLanguages() = %v, want nil", got)
	}
	if got := s.GetDefaultLanguage(); got != "fa" {
		t.Errorf("GetDefaultLanguage() = %q, want %q", got, "fa")
	}
}

// Close and StartWatching are called from main's shutdown and boot paths
// regardless of whether Load succeeded, so neither may panic on a nil client.
func TestUnconnectedStoreLifecycleIsANoop(t *testing.T) {
	s := newTestStore("", "backend", "fa")

	if err := s.StartWatching(true); err != nil {
		t.Errorf("StartWatching() on an unconnected store = %v, want nil", err)
	}
	if err := s.Close(); err != nil {
		t.Errorf("Close() on an unconnected store = %v, want nil", err)
	}
	// Shutdown can run twice on a signal race; the second must be harmless.
	if err := s.Close(); err != nil {
		t.Errorf("second Close() = %v, want nil", err)
	}
}

// Load is deliberately not exercised here: it dials with a 60s boot timeout,
// so an unreachable-address test would cost a minute of every `go test ./...`
// run to assert one error return. What Load builds — the gRPC client's cache,
// fallback and watch — is covered in i18n-platform/clients/go.
