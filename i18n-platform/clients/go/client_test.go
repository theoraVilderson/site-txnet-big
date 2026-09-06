package localeclient

import (
	"context"
	"net"
	"reflect"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/txnet/i18n-platform/clients/go/localev1"
)

// This client is the copy every Go service vendors, so its contract is the
// contract for the whole platform: a blocking boot that fails fast rather than
// serving an empty string table, a cache replaced per language rather than
// merged, and a lookup that falls back — default language, then the key
// itself — instead of ever returning empty or panicking. Those are the four
// behaviours a vendored copy must not drift on. They are exercised against a
// real gRPC server over a loopback socket, because half of them only exist in
// the interaction with the stream.

// --- a scriptable locale-service ---------------------------------------

type fakeService struct {
	localev1.UnimplementedLocaleServiceServer

	mu sync.Mutex
	// snapshots keyed by lang; a missing lang answers NotFound.
	snapshots map[string]*localev1.SnapshotResponse
	locales   []*localev1.LocaleMeta
	// failSnapshot forces GetSnapshot to fail this many more times.
	failSnapshot int
	// calls records the RPCs served, for the boot/re-sync assertions.
	calls []string
	// watchers receives each connected Watch stream's push channel.
	watchers []chan *localev1.UpdateEvent
	// watchRequests records what the client asked to watch.
	watchRequests []*localev1.WatchRequest
}

func newFakeService() *fakeService {
	return &fakeService{snapshots: map[string]*localev1.SnapshotResponse{}}
}

func (f *fakeService) record(name string) {
	f.mu.Lock()
	f.calls = append(f.calls, name)
	f.mu.Unlock()
}

func (f *fakeService) served() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeService) setSnapshot(snap *localev1.SnapshotResponse) {
	f.mu.Lock()
	f.snapshots[snap.GetLang()] = snap
	f.mu.Unlock()
}

func (f *fakeService) GetSnapshot(_ context.Context, req *localev1.SnapshotRequest) (*localev1.SnapshotResponse, error) {
	f.record("GetSnapshot:" + req.GetLang())
	f.mu.Lock()
	if f.failSnapshot > 0 {
		f.failSnapshot--
		f.mu.Unlock()
		return nil, status.Error(codes.Unavailable, "not ready")
	}
	snap, ok := f.snapshots[req.GetLang()]
	f.mu.Unlock()
	if !ok {
		return nil, status.Errorf(codes.NotFound, "unknown lang %s", req.GetLang())
	}
	return snap, nil
}

func (f *fakeService) GetAvailableLocales(context.Context, *localev1.Empty) (*localev1.AvailableLocalesResponse, error) {
	f.record("GetAvailableLocales")
	f.mu.Lock()
	defer f.mu.Unlock()
	return &localev1.AvailableLocalesResponse{Locales: f.locales}, nil
}

func (f *fakeService) Watch(req *localev1.WatchRequest, stream grpc.ServerStreamingServer[localev1.UpdateEvent]) error {
	f.record("Watch")
	ch := make(chan *localev1.UpdateEvent, 8)
	f.mu.Lock()
	f.watchers = append(f.watchers, ch)
	f.watchRequests = append(f.watchRequests, req)
	f.mu.Unlock()

	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case ev := <-ch:
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
	}
}

// push sends an event to every connected watcher.
func (f *fakeService) push(ev *localev1.UpdateEvent) {
	f.mu.Lock()
	watchers := append([]chan *localev1.UpdateEvent(nil), f.watchers...)
	f.mu.Unlock()
	for _, ch := range watchers {
		ch <- ev
	}
}

func (f *fakeService) watcherCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.watchers)
}

// serve starts the fake on a loopback port and returns its address.
func serve(t *testing.T, svc *fakeService) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	localev1.RegisterLocaleServiceServer(gs, svc)
	go func() { _ = gs.Serve(ln) }()
	t.Cleanup(gs.Stop)
	return ln.Addr().String()
}

// --- fixtures -----------------------------------------------------------

func snapshot(lang string, version string, namespaces map[string]map[string]string) *localev1.SnapshotResponse {
	out := &localev1.SnapshotResponse{
		Lang:       lang,
		Scope:      "backend",
		Version:    version,
		Namespaces: map[string]*localev1.NamespaceData{},
	}
	for ns, entries := range namespaces {
		out.Namespaces[ns] = &localev1.NamespaceData{Entries: entries}
	}
	return out
}

// twoLanguageService is the common fixture: en and fa, one namespace each.
func twoLanguageService() *fakeService {
	svc := newFakeService()
	svc.locales = []*localev1.LocaleMeta{
		{Code: "en", Name: "English", Dir: "ltr"},
		{Code: "fa", Name: "Persian", Dir: "rtl"},
	}
	svc.setSnapshot(snapshot("en", "v1", map[string]map[string]string{
		"errors":   {"auth.unauthorized": "Unauthorized", "auth.only_in_en": "English only"},
		"messages": {"greeting": "Hello {{name}}", "spaced": "Hi {{ name }}"},
	}))
	svc.setSnapshot(snapshot("fa", "v1", map[string]map[string]string{
		"errors": {"auth.unauthorized": "دسترسی ندارید"},
	}))
	return svc
}

func newClient(t *testing.T, addr string, cfg Config) *Client {
	t.Helper()
	cfg.Addr = addr
	if cfg.BootTimeout == 0 {
		cfg.BootTimeout = 5 * time.Second
	}
	c, err := New(context.Background(), cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// --- boot ---------------------------------------------------------------

func TestNewRequiresAnAddress(t *testing.T) {
	if _, err := New(context.Background(), Config{Scope: "backend"}); err == nil {
		t.Fatal("New() with no Addr returned nil error")
	}
}

// The boot is blocking on purpose: a service that starts before its strings
// are cached serves raw keys to real users for its first seconds.
func TestNewBlocksUntilEveryPreloadLanguageIsCached(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en", "fa"}})

	if got := c.Translate("en", "errors", "auth.unauthorized"); got != "Unauthorized" {
		t.Errorf("en lookup right after New = %q, want it already cached", got)
	}
	if got := c.Translate("fa", "errors", "auth.unauthorized"); got != "دسترسی ندارید" {
		t.Errorf("fa lookup right after New = %q, want it already cached", got)
	}
	// An explicit preload list must not cost a GetAvailableLocales round-trip.
	for _, call := range svc.served() {
		if call == "GetAvailableLocales" {
			t.Error("GetAvailableLocales was called despite an explicit PreloadLangs")
		}
	}
}

// With no PreloadLangs the client loads whatever the service advertises, so a
// language added on the server does not need a client config change.
func TestNewWithoutPreloadLoadsEveryAdvertisedLanguage(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend"})

	if got := c.Languages(); !reflect.DeepEqual(got, []string{"en", "fa"}) {
		t.Errorf("Languages() = %v, want [en fa] sorted", got)
	}
	if got := c.DefaultLang(); got != "en" {
		t.Errorf("DefaultLang() = %q, want the first advertised language", got)
	}
}

func TestDefaultLangFallsBackToTheFirstPreloadLanguage(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"fa", "en"}})
	if got := c.DefaultLang(); got != "fa" {
		t.Errorf("DefaultLang() = %q, want fa", got)
	}
}

// locale-service is usually still starting when its consumers are; the boot
// retries rather than failing on the first refused RPC.
func TestNewRetriesWhileTheServiceIsStillStarting(t *testing.T) {
	svc := twoLanguageService()
	svc.failSnapshot = 2

	c := newClient(t, serve(t, svc), Config{
		Scope: "backend", PreloadLangs: []string{"en"}, BootTimeout: 10 * time.Second,
	})
	if got := c.Translate("en", "errors", "auth.unauthorized"); got != "Unauthorized" {
		t.Errorf("Translate() = %q, want the retried boot to have cached en", got)
	}
}

// Failing fast is the point of BootTimeout: a service that starts anyway with
// an empty cache would serve keys instead of text and nobody would notice.
func TestNewFailsWhenTheServiceNeverAnswers(t *testing.T) {
	svc := newFakeService() // knows no languages at all
	_, err := New(context.Background(), Config{
		Addr: serve(t, svc), Scope: "backend",
		PreloadLangs: []string{"en"}, BootTimeout: 1500 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("New() returned nil error when no snapshot could be fetched")
	}
}

func TestNewHonoursACancelledContext(t *testing.T) {
	svc := newFakeService()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := New(ctx, Config{
		Addr: serve(t, svc), Scope: "backend",
		PreloadLangs: []string{"en"}, BootTimeout: 10 * time.Second,
	})
	if err == nil {
		t.Fatal("New() with a cancelled context returned nil error")
	}
}

// --- lookup and fallback -------------------------------------------------

// The fallback chain is what keeps a half-translated language usable: the
// requested language, then the default, then the key. Returning "" anywhere in
// that chain would put blank text in front of a user.
func TestTranslateFallbackChain(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en", "fa"}, DefaultLang: "en"})

	tests := []struct {
		name          string
		lang, ns, key string
		want          string
	}{
		{"present in the asked language", "fa", "errors", "auth.unauthorized", "دسترسی ندارید"},
		{"missing key falls back to the default language", "fa", "errors", "auth.only_in_en", "English only"},
		{"missing namespace falls back too", "fa", "messages", "greeting", "Hello {{name}}"},
		{"missing everywhere returns the key", "fa", "errors", "auth.nowhere", "auth.nowhere"},
		{"missing in the default language returns the key", "en", "errors", "auth.nowhere", "auth.nowhere"},
		{"unknown language falls back to the default", "de", "errors", "auth.unauthorized", "Unauthorized"},
		{"unknown language and unknown key returns the key", "de", "errors", "nope", "nope"},
		{"unknown namespace returns the key", "en", "nope", "auth.unauthorized", "auth.unauthorized"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := c.Translate(tc.lang, tc.ns, tc.key); got != tc.want {
				t.Errorf("Translate(%q,%q,%q) = %q, want %q", tc.lang, tc.ns, tc.key, got, tc.want)
			}
		})
	}
}

func TestInterpolation(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en"}})

	tests := []struct {
		name string
		key  string
		vars map[string]string
		want string
	}{
		{"substitutes a variable", "greeting", map[string]string{"name": "Ada"}, "Hello Ada"},
		{"tolerates whitespace inside the braces", "spaced", map[string]string{"name": "Ada"}, "Hi Ada"},
		{"leaves an unsupplied variable in place", "greeting", map[string]string{"other": "x"}, "Hello {{name}}"},
		{"nil vars is not a crash", "greeting", nil, "Hello {{name}}"},
		{"an extra variable is ignored", "greeting", map[string]string{"name": "Ada", "unused": "y"}, "Hello Ada"},
		{"an empty value substitutes as empty", "greeting", map[string]string{"name": ""}, "Hello "},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := c.T("en", "messages", tc.key, tc.vars); got != tc.want {
				t.Errorf("T() = %q, want %q", got, tc.want)
			}
		})
	}
}

// A key that was never translated must come back as the key, not as an
// interpolated key — the placeholder braces are part of the diagnostic.
func TestTMissingKeyIsNotInterpolated(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en"}})
	if got := c.T("en", "messages", "no.such.key", map[string]string{"name": "Ada"}); got != "no.such.key" {
		t.Errorf("T() = %q, want the key returned untouched", got)
	}
}

func TestNamespaceReturnsACopy(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en"}})

	entries, ok := c.Namespace("en", "errors")
	if !ok {
		t.Fatal("Namespace(en, errors) not ok")
	}
	entries["auth.unauthorized"] = "MUTATED"

	if got := c.Translate("en", "errors", "auth.unauthorized"); got != "Unauthorized" {
		t.Errorf("Translate() = %q after a caller mutated its copy, want the cache intact", got)
	}
	if _, ok := c.Namespace("en", "nope"); ok {
		t.Error("Namespace() reported ok for a namespace that does not exist")
	}
	if _, ok := c.Namespace("de", "errors"); ok {
		t.Error("Namespace() reported ok for a language that is not cached")
	}
}

// An explicit PreloadLangs is a priority order, not just a filter — the first
// entry is the default language, so the order has to survive.
func TestLanguagesKeepsTheConfiguredOrder(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"fa", "en"}})
	if got := c.Languages(); !reflect.DeepEqual(got, []string{"fa", "en"}) {
		t.Errorf("Languages() = %v, want the configured order [fa en]", got)
	}
}

func TestResolveLanguage(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en", "fa"}, DefaultLang: "en"})

	tests := []struct {
		header string
		want   string
	}{
		{"", "en"},
		{"fa", "fa"},
		{"FA", "fa"},
		{"fa-IR", "fa"},
		{"fa-IR,fa;q=0.9,en;q=0.8", "fa"},
		{"de-DE,de;q=0.9,fa;q=0.8", "fa"},
		{"de", "en"},
		{"  fa  ", "fa"},
		{",,fa", "fa"},
		{";q=0.9", "en"},
	}
	for _, tc := range tests {
		if got := c.ResolveLanguage(tc.header); got != tc.want {
			t.Errorf("ResolveLanguage(%q) = %q, want %q", tc.header, got, tc.want)
		}
	}
}

// --- the watch stream ----------------------------------------------------

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// A pushed snapshot replaces the language wholesale. Merging instead would
// leave a deleted key answering forever, which is how a removed string
// outlives the release that removed it.
func TestWatchReplacesTheCacheRatherThanMergingIt(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en"}})

	c.StartWatch()
	waitFor(t, "the watch stream to connect", func() bool { return svc.watcherCount() == 1 })

	svc.push(&localev1.UpdateEvent{
		Lang: "en", Scope: "backend", NewVersion: "v2",
		FullSnapshot: snapshot("en", "v2", map[string]map[string]string{
			"errors": {"auth.unauthorized": "Not allowed"},
		}),
	})

	waitFor(t, "the pushed snapshot to land", func() bool {
		return c.Translate("en", "errors", "auth.unauthorized") == "Not allowed"
	})
	// auth.only_in_en was in v1 and not in v2; it must be gone, not merged.
	if got := c.Translate("en", "errors", "auth.only_in_en"); got != "auth.only_in_en" {
		t.Errorf("a key removed in v2 still resolves to %q; the cache was merged, not replaced", got)
	}
	// A namespace dropped entirely goes with it.
	if _, ok := c.Namespace("en", "messages"); ok {
		t.Error("a namespace absent from v2 survived the replace")
	}
}

// An event with no snapshot attached is a no-op, not a cache wipe.
func TestWatchIgnoresAnEventWithNoSnapshot(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en"}})
	c.StartWatch()
	waitFor(t, "the watch stream to connect", func() bool { return svc.watcherCount() == 1 })

	svc.push(&localev1.UpdateEvent{Lang: "en", Scope: "backend", NewVersion: "v2"})
	time.Sleep(200 * time.Millisecond)

	if got := c.Translate("en", "errors", "auth.unauthorized"); got != "Unauthorized" {
		t.Errorf("Translate() = %q after a snapshot-less event, want the cache untouched", got)
	}
}

// The watch has to ask for the same scope and languages the client caches, or
// it is kept fresh on the wrong data.
func TestStartWatchSubscribesToTheConfiguredScopeAndLangs(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en", "fa"}})
	c.StartWatch()
	waitFor(t, "the watch stream to connect", func() bool { return svc.watcherCount() == 1 })

	svc.mu.Lock()
	req := svc.watchRequests[0]
	svc.mu.Unlock()

	if req.GetScope() != "backend" {
		t.Errorf("watch scope = %q, want backend", req.GetScope())
	}
	if !reflect.DeepEqual(req.GetLangs(), []string{"en", "fa"}) {
		t.Errorf("watch langs = %v, want [en fa]", req.GetLangs())
	}
}

// StartWatch is called from more than one place in a service's boot; a second
// call must not open a second stream.
func TestStartWatchIsIdempotent(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en"}})

	c.StartWatch()
	waitFor(t, "the watch stream to connect", func() bool { return svc.watcherCount() == 1 })
	c.StartWatch()
	c.StartWatch()
	time.Sleep(300 * time.Millisecond)

	if got := svc.watcherCount(); got != 1 {
		t.Errorf("%d watch streams open, want 1", got)
	}
}

// Close must return once the watch goroutine has stopped; a Close that
// returned early would leave the goroutine using a closed connection.
func TestCloseStopsTheWatch(t *testing.T) {
	svc := twoLanguageService()
	addr := serve(t, svc)
	c, err := New(context.Background(), Config{
		Addr: addr, Scope: "backend", PreloadLangs: []string{"en"}, BootTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	c.StartWatch()
	waitFor(t, "the watch stream to connect", func() bool { return svc.watcherCount() == 1 })

	done := make(chan error, 1)
	go func() { done <- c.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Close() = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close() did not return; the watch goroutine was not stopped")
	}
}

// Close on a client that never started watching is the shutdown path of any
// consumer that only preloads.
func TestCloseWithoutWatching(t *testing.T) {
	svc := twoLanguageService()
	c, err := New(context.Background(), Config{
		Addr: serve(t, svc), Scope: "backend", PreloadLangs: []string{"en"}, BootTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Errorf("Close() = %v, want nil", err)
	}
}

// Lookups after Close must still answer from the cache rather than panicking:
// shutdown is not an excuse to crash a request that is already in flight.
func TestTranslateAfterCloseStillAnswersFromCache(t *testing.T) {
	svc := twoLanguageService()
	c, err := New(context.Background(), Config{
		Addr: serve(t, svc), Scope: "backend", PreloadLangs: []string{"en"}, BootTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_ = c.Close()

	if got := c.Translate("en", "errors", "auth.unauthorized"); got != "Unauthorized" {
		t.Errorf("Translate() after Close = %q, want the cached value", got)
	}
}

// --- uncached RPCs -------------------------------------------------------

func TestAvailableLocalesAndSnapshotGoToTheService(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en"}})

	locales, err := c.AvailableLocales(context.Background())
	if err != nil {
		t.Fatalf("AvailableLocales: %v", err)
	}
	if len(locales) != 2 || locales[0].GetCode() != "en" {
		t.Errorf("AvailableLocales() = %+v, want en and fa", locales)
	}

	// Snapshot is what codegen uses; it must bypass the cache and report the
	// service's current version.
	svc.setSnapshot(snapshot("en", "v9", map[string]map[string]string{"errors": {"a": "b"}}))
	snap, err := c.Snapshot(context.Background(), "en")
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snap.GetVersion() != "v9" {
		t.Errorf("Snapshot version = %q, want the live v9, not the cached v1", snap.GetVersion())
	}
	if got := c.Translate("en", "errors", "auth.unauthorized"); got != "Unauthorized" {
		t.Errorf("Snapshot() changed the cache; Translate = %q, want the cached v1 value", got)
	}
}

func TestSnapshotOfAnUnknownLanguageIsAnError(t *testing.T) {
	svc := twoLanguageService()
	c := newClient(t, serve(t, svc), Config{Scope: "backend", PreloadLangs: []string{"en"}})

	if _, err := c.Snapshot(context.Background(), "de"); status.Code(err) != codes.NotFound {
		t.Errorf("Snapshot(de) error code = %v, want NotFound", status.Code(err))
	}
}
