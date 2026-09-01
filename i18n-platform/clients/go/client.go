// Package localeclient is the canonical Go client for locale-service.
//
// It is NOT meant to be imported as a shared module. Every Go service vendors a
// copy of this directory (client.go + localev1/) under its own internal tree and
// rewrites the localev1 import path to match. See i18n-platform/README.md.
//
// Behaviour contract (identical to the Node client):
//   - New() blocks until the first GetSnapshot for every preload language
//     succeeds or BootTimeout elapses (then it fails fast).
//   - The in-memory cache is replaced atomically per language — never merged.
//   - A background Watch stream keeps the cache fresh; on disconnect it
//     reconnects with exponential backoff (1s→2s→…→MaxBackoff) and re-fetches a
//     fresh snapshot for every preload language.
//   - A missing key returns the key itself; translation never panics.
package localeclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"github.com/txnet/i18n-platform/clients/go/localev1"
)

// Config configures a Client.
type Config struct {
	// Addr is the locale-service gRPC address, e.g. "localhost:50051".
	Addr string
	// Scope is "backend", "frontend" or "" (every scope, namespace keys prefixed
	// with "<scope>/").
	Scope string
	// PreloadLangs are fetched (blocking) during New and kept live by Watch.
	// Leave it nil/empty to load EVERY language locale-service advertises
	// (languages added later are picked up automatically over the Watch stream).
	PreloadLangs []string
	// DefaultLang is used as the fallback language by Translate. Defaults to the
	// first preload language.
	DefaultLang string
	// BootTimeout caps the blocking boot. Default 10s.
	BootTimeout time.Duration
	// MaxBackoff caps the Watch reconnect backoff. Default 30s.
	MaxBackoff time.Duration
	// DialOptions are appended to the defaults (insecure credentials).
	DialOptions []grpc.DialOption
	// Logger is optional; a discard logger is used when nil.
	Logger *slog.Logger
}

// Client is a live, cached view of one scope of locale-service.
type Client struct {
	cfg  Config
	log  *slog.Logger
	conn *grpc.ClientConn
	rpc  localev1.LocaleServiceClient

	mu       sync.RWMutex
	byLang   map[string]*localev1.SnapshotResponse
	watching bool

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

var varRe = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_]+)\s*\}\}`)

// New dials locale-service and performs the blocking boot.
func New(ctx context.Context, cfg Config) (*Client, error) {
	if cfg.Addr == "" {
		return nil, errors.New("localeclient: Addr is required")
	}
	if cfg.BootTimeout == 0 {
		cfg.BootTimeout = 10 * time.Second
	}
	if cfg.MaxBackoff == 0 {
		cfg.MaxBackoff = 30 * time.Second
	}
	if cfg.DefaultLang == "" && len(cfg.PreloadLangs) > 0 {
		cfg.DefaultLang = cfg.PreloadLangs[0]
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	dialOpts := append([]grpc.DialOption{
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		// locale-service is always internal — ignore HTTP(S)_PROXY from the env.
		grpc.WithNoProxy(),
	}, cfg.DialOptions...)

	conn, err := grpc.NewClient(cfg.Addr, dialOpts...)
	if err != nil {
		return nil, fmt.Errorf("localeclient: dial %s: %w", cfg.Addr, err)
	}

	c := &Client{
		cfg:    cfg,
		log:    cfg.Logger,
		conn:   conn,
		rpc:    localev1.NewLocaleServiceClient(conn),
		byLang: map[string]*localev1.SnapshotResponse{},
	}

	if err := c.boot(ctx); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return c, nil
}

// preloadAll is true when no explicit language list was configured — the client
// then loads every language locale-service advertises.
func (c *Client) preloadAll() bool { return len(c.cfg.PreloadLangs) == 0 }

// targetLangs is the set of languages to (pre)load and re-sync. With an explicit
// PreloadLangs it is exactly that; otherwise it is every advertised locale.
func (c *Client) targetLangs(ctx context.Context) ([]string, error) {
	if !c.preloadAll() {
		return c.cfg.PreloadLangs, nil
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := c.rpc.GetAvailableLocales(rctx, &localev1.Empty{})
	if err != nil {
		return nil, err
	}
	langs := make([]string, 0, len(resp.GetLocales()))
	for _, m := range resp.GetLocales() {
		if m.GetCode() != "" {
			langs = append(langs, m.GetCode())
		}
	}
	return langs, nil
}

func (c *Client) boot(ctx context.Context) error {
	deadline := time.Now().Add(c.cfg.BootTimeout)
	attempt := 0
	var lastErr error
	for time.Now().Before(deadline) {
		langs, err := c.targetLangs(ctx)
		ok := err == nil && len(langs) > 0
		if err != nil {
			lastErr = err
		}
		for _, lang := range langs {
			snap, ferr := c.fetch(ctx, lang)
			if ferr != nil {
				lastErr, ok = ferr, false
				break
			}
			c.replace(snap)
		}
		if ok {
			if c.cfg.DefaultLang == "" && len(langs) > 0 {
				c.cfg.DefaultLang = langs[0]
			}
			return nil
		}
		attempt++
		wait := time.Duration(attempt) * time.Second
		if wait > 3*time.Second {
			wait = 3 * time.Second
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	return fmt.Errorf("localeclient: boot failed, locale-service unavailable: %w", lastErr)
}

func (c *Client) fetch(ctx context.Context, lang string) (*localev1.SnapshotResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.rpc.GetSnapshot(ctx, &localev1.SnapshotRequest{Lang: lang, Scope: c.cfg.Scope})
}

func (c *Client) replace(snap *localev1.SnapshotResponse) {
	c.mu.Lock()
	c.byLang[snap.GetLang()] = snap
	c.mu.Unlock()
}

// StartWatch launches the background Watch stream. It is idempotent.
func (c *Client) StartWatch() {
	c.mu.Lock()
	if c.watching {
		c.mu.Unlock()
		return
	}
	c.watching = true
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.mu.Unlock()

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.watchLoop(ctx)
	}()
}

func (c *Client) watchLoop(ctx context.Context) {
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		stream, err := c.rpc.Watch(ctx, &localev1.WatchRequest{
			Langs: c.cfg.PreloadLangs,
			Scope: c.cfg.Scope,
		})
		if err == nil {
			backoff = time.Second
			err = c.consume(stream)
		}
		if ctx.Err() != nil {
			return
		}
		c.log.Warn("locale watch disconnected, reconnecting", "after", backoff, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > c.cfg.MaxBackoff {
			backoff = c.cfg.MaxBackoff
		}
		// Re-sync: a change may have happened during the outage.
		if langs, lerr := c.targetLangs(ctx); lerr == nil {
			for _, lang := range langs {
				if snap, ferr := c.fetch(ctx, lang); ferr == nil {
					c.replace(snap)
				}
			}
		}
	}
}

func (c *Client) consume(stream grpc.ServerStreamingClient[localev1.UpdateEvent]) error {
	for {
		ev, err := stream.Recv()
		if err != nil {
			return err
		}
		if snap := ev.GetFullSnapshot(); snap != nil {
			c.replace(snap)
			c.log.Info("locale updated", "lang", ev.GetLang(), "scope", ev.GetScope(), "version", ev.GetNewVersion())
		}
	}
}

// Close stops the Watch stream and closes the connection.
func (c *Client) Close() error {
	c.mu.Lock()
	cancel := c.cancel
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	c.wg.Wait()
	return c.conn.Close()
}

// T translates a key and interpolates {{var}} placeholders. Unknown key → key.
func (c *Client) T(lang, namespace, key string, vars map[string]string) string {
	raw, ok := c.lookup(lang, namespace, key)
	if !ok {
		if lang != c.cfg.DefaultLang {
			if raw, ok = c.lookup(c.cfg.DefaultLang, namespace, key); !ok {
				return key
			}
		} else {
			return key
		}
	}
	return render(raw, vars)
}

// Translate is T without interpolation.
func (c *Client) Translate(lang, namespace, key string) string {
	return c.T(lang, namespace, key, nil)
}

func (c *Client) lookup(lang, namespace, key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	snap := c.byLang[lang]
	if snap == nil {
		return "", false
	}
	ns := snap.GetNamespaces()[namespace]
	if ns == nil {
		return "", false
	}
	v, ok := ns.GetEntries()[key]
	return v, ok
}

// Namespace returns a copy of one namespace's flat entries.
func (c *Client) Namespace(lang, namespace string) (map[string]string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	snap := c.byLang[lang]
	if snap == nil {
		return nil, false
	}
	ns := snap.GetNamespaces()[namespace]
	if ns == nil {
		return nil, false
	}
	out := make(map[string]string, len(ns.GetEntries()))
	for k, v := range ns.GetEntries() {
		out[k] = v
	}
	return out, true
}

// Languages returns the languages currently in cache. With an explicit
// PreloadLangs the configured order is kept; otherwise the result is sorted.
func (c *Client) Languages() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]string, 0, len(c.byLang))
	for _, l := range c.cfg.PreloadLangs {
		if _, ok := c.byLang[l]; ok {
			out = append(out, l)
		}
	}
	rest := make([]string, 0, len(c.byLang))
	for l := range c.byLang {
		if !contains(out, l) {
			rest = append(rest, l)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// DefaultLang returns the configured fallback language.
func (c *Client) DefaultLang() string { return c.cfg.DefaultLang }

// ResolveLanguage picks the best cached language for an Accept-Language header,
// falling back to DefaultLang.
func (c *Client) ResolveLanguage(acceptLanguage string) string {
	available := c.Languages()
	if acceptLanguage == "" {
		return c.cfg.DefaultLang
	}
	for _, part := range strings.Split(acceptLanguage, ",") {
		code := strings.TrimSpace(strings.Split(part, ";")[0])
		if code == "" {
			continue
		}
		full := strings.ToLower(code)
		base := strings.ToLower(strings.Split(code, "-")[0])
		for _, l := range available {
			if l == full || l == base {
				return l
			}
		}
	}
	return c.cfg.DefaultLang
}

// AvailableLocales fetches locale metadata (uncached).
func (c *Client) AvailableLocales(ctx context.Context) ([]*localev1.LocaleMeta, error) {
	resp, err := c.rpc.GetAvailableLocales(ctx, &localev1.Empty{})
	if err != nil {
		return nil, err
	}
	return resp.GetLocales(), nil
}

// Snapshot fetches a fresh snapshot (uncached) — used by codegen.
func (c *Client) Snapshot(ctx context.Context, lang string) (*localev1.SnapshotResponse, error) {
	return c.fetch(ctx, lang)
}

func render(raw string, vars map[string]string) string {
	if !strings.Contains(raw, "{{") {
		return raw
	}
	return varRe.ReplaceAllStringFunc(raw, func(m string) string {
		name := varRe.FindStringSubmatch(m)[1]
		if v, ok := vars[name]; ok {
			return v
		}
		return m
	})
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
