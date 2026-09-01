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
	logger      *slog.Logger
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
		addr: addr, scope: scope, defaultLang: defaultLang, logger: logger,
	}
}

// Load dials locale-service and blocks until the initial snapshots are cached.
func (s *Store) Load() error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	client, err := localeclient.New(ctx, localeclient.Config{
		Addr:        s.addr,
		Scope:       s.scope,
		DefaultLang: s.defaultLang,
		BootTimeout: 60 * time.Second, // survive locale-service still starting
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
