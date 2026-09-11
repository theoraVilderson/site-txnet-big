package locale

import (
	"io"
	"log/slog"
	"testing"
	"time"
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

// F-086. The boot timeout was hardcoded twice at two different values — 60s
// here and 10s inside the shared client — and which one applied depended on
// whether the caller happened to set the field. These assertions are about the
// two ways that can go wrong once it is configurable.
func TestBootTimeoutDefaultsAndOverrides(t *testing.T) {
	store := newTestStore("", "backend", "fa")
	if store.bootTimeout != DefaultBootTimeout {
		t.Errorf("bootTimeout = %v, want the declared default %v",
			store.bootTimeout, DefaultBootTimeout)
	}

	store.WithBootTimeout(5 * time.Second)
	if store.bootTimeout != 5*time.Second {
		t.Errorf("bootTimeout = %v after override, want 5s", store.bootTimeout)
	}
}

// An unset or nonsensical LOCALE_BOOT_TIMEOUT must not mean "give up
// immediately". A gateway that stops waiting before its translations arrive
// comes up serving raw message keys to every user, which is worse than a slow
// boot and much harder to notice.
func TestBootTimeoutIgnoresNonPositiveOverrides(t *testing.T) {
	for _, d := range []time.Duration{0, -1 * time.Second} {
		store := newTestStore("", "backend", "fa").WithBootTimeout(d)
		if store.bootTimeout != DefaultBootTimeout {
			t.Errorf("WithBootTimeout(%v) left bootTimeout = %v, want %v",
				d, store.bootTimeout, DefaultBootTimeout)
		}
	}
}

// Load's own deadline has to outlast the boot wait it contains, or the outer
// context cancels first and the operator reads a bare "context deadline
// exceeded" instead of the client's explanation of what it was waiting for.
func TestDialTimeoutOutlastsTheBootWait(t *testing.T) {
	store := newTestStore("", "backend", "fa").WithBootTimeout(20 * time.Second)
	if store.dialTimeout() <= store.bootTimeout {
		t.Errorf("dialTimeout() = %v, must exceed bootTimeout %v",
			store.dialTimeout(), store.bootTimeout)
	}
}
