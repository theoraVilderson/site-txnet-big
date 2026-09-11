// Package locale adapts the vendored gRPC locale client (internal/localeclient)
// to the small surface the gateway needs. locale-service is the source of truth;
// this process only keeps a live in-memory cache of the "backend" scope.
package locale

import (
	"context"
	"log/slog"
	"time"

	localeclient "github.com/txnet/i18n-platform/clients/go"
)

// Store is a thin wrapper around *localeclient.Client. The name and method set
// are kept stable so the middleware/handlers don't care about the transport.
type Store struct {
	client      *localeclient.Client
	addr        string
	scope       string
	defaultLang string
	bootTimeout time.Duration
	logger      *slog.Logger
}

// DefaultBootTimeout is how long Load waits for the first snapshots.
//
// **One value, from config** (F-086, ADR-0036). This was `60 * time.Second`
// here and `10 * time.Second` inside the shared client — two hardcoded numbers
// for the same wait, disagreeing by six times. Whichever one applied depended
// on whether the caller happened to set the field, which is not a decision
// anybody made.
//
// Sixty is the right default for *this* process rather than for the library:
// `auth-handler` and `locale-service` start together, and a gateway that gives
// up before its translations arrive comes up serving raw message keys to every
// user. The shared client's ten seconds suits a caller that can retry; this one
// cannot, because it blocks the boot.
const DefaultBootTimeout = 60 * time.Second

// dialTimeout bounds the whole of Load, not just the boot wait — the dial and
// the snapshot fetch both happen inside it. Half again as long as the boot
// timeout so the inner deadline is the one that fires, and its clearer error is
// the one an operator reads.
func (s *Store) dialTimeout() time.Duration {
	return s.bootTimeout + s.bootTimeout/2
}

// WithBootTimeout overrides how long Load waits. Zero or negative keeps
// DefaultBootTimeout: an unset or nonsensical env var must not mean "give up
// immediately", which is the failure a plain assignment would allow.
//
// A setter rather than another positional parameter: NewStore already takes
// four, and the five call sites that do not care about this should not have to
// mention it.
func (s *Store) WithBootTimeout(d time.Duration) *Store {
	if d > 0 {
		s.bootTimeout = d
	}
	return s
}

// NewStore configures (but does not yet connect) a locale store.
//
//	addr        locale-service gRPC address, e.g. "localhost:50051"
//	scope       "backend" (this service only needs backend + shareds namespaces)
//	defaultLang fallback language, e.g. "fa"
//
// Every language locale-service advertises is loaded on boot and kept live.
func NewStore(addr, scope, defaultLang string, logger *slog.Logger) *Store {
	if scope == "" {
		scope = "backend"
	}
	return &Store{
		addr: addr, scope: scope, defaultLang: defaultLang,
		bootTimeout: DefaultBootTimeout, logger: logger,
	}
}

// Load dials locale-service and blocks until the initial snapshots are cached.
func (s *Store) Load() error {
	ctx, cancel := context.WithTimeout(context.Background(), s.dialTimeout())
	defer cancel()

	client, err := localeclient.New(ctx, localeclient.Config{
		Addr:        s.addr,
		Scope:       s.scope,
		DefaultLang: s.defaultLang,
		BootTimeout: s.bootTimeout,
		Logger:      s.logger,
	})
	if err != nil {
		return err
	}
	s.client = client
	return nil
}

// StartWatching launches the background Watch stream. The bool is kept for
// call-site compatibility; the stream is always started because live reload is
// the whole point of talking to locale-service.
func (s *Store) StartWatching(_ bool) error {
	if s.client == nil {
		return nil
	}
	s.client.StartWatch()
	return nil
}

// Close stops the Watch stream and closes the gRPC connection.
func (s *Store) Close() error {
	if s.client == nil {
		return nil
	}
	return s.client.Close()
}

// ResolveLanguage picks the best available language for an Accept-Language header.
func (s *Store) ResolveLanguage(acceptLanguage string) string {
	if s.client == nil {
		return s.defaultLang
	}
	return s.client.ResolveLanguage(acceptLanguage)
}

// Translate returns the translation for lang/namespace/key, falling back to the
// default language and finally to the key itself.
func (s *Store) Translate(lang, namespace, key string) string {
	if s.client == nil {
		return key
	}
	return s.client.Translate(lang, namespace, key)
}

// TranslateWith is Translate plus {{var}} interpolation.
func (s *Store) TranslateWith(lang, namespace, key string, vars map[string]string) string {
	if s.client == nil {
		return key
	}
	return s.client.T(lang, namespace, key, vars)
}

// GetAvailableLanguages returns the language codes currently cached.
func (s *Store) GetAvailableLanguages() []string {
	if s.client == nil {
		return nil
	}
	return s.client.Languages()
}

// GetDefaultLanguage returns the configured default language.
func (s *Store) GetDefaultLanguage() string { return s.defaultLang }
