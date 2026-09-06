package server

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/txnet/i18n-platform/services/locale-service/internal/localev1"
	"github.com/txnet/i18n-platform/services/locale-service/internal/store"
)

// The gRPC layer's own job is the Watch broadcaster: which subscribers get an
// event, and — the part that is easy to get wrong and impossible to see in
// review — that an event is only sent when the version for that (scope, lang)
// actually moved. A broadcaster that fires on every reload would have every
// client in the platform refetch the whole string table whenever anyone
// touched any file.

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
}

func newServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"backend/langs/en/metadata.json": `{"code":"en","name":"English","dir":"ltr","locale":"en-US"}`,
		"backend/langs/en/errors.json":   `{"auth":{"unauthorized":"Unauthorized"}}`,
		"backend/langs/fa/metadata.json": `{"code":"fa","name":"Persian","dir":"rtl","locale":"fa-IR"}`,
		"backend/langs/fa/errors.json":   `{"auth":{"unauthorized":"دسترسی ندارید"}}`,
		"frontend/langs/en/common.json":  `{"submit":"Submit"}`,
	})
	s := store.New(root)
	if err := s.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	return New(s), root
}

// --- unary RPCs ---------------------------------------------------------

func TestGetSnapshotRequiresALanguage(t *testing.T) {
	srv, _ := newServer(t)
	_, err := srv.GetSnapshot(context.Background(), &localev1.SnapshotRequest{Scope: "backend"})
	if status.Code(err) != codes.InvalidArgument {
		t.Errorf("code = %v, want InvalidArgument", status.Code(err))
	}
}

func TestGetSnapshotUnknownLanguageIsNotFound(t *testing.T) {
	srv, _ := newServer(t)
	_, err := srv.GetSnapshot(context.Background(), &localev1.SnapshotRequest{Lang: "de", Scope: "backend"})
	if status.Code(err) != codes.NotFound {
		t.Errorf("code = %v, want NotFound", status.Code(err))
	}
}

func TestGetSnapshotCarriesTheStoreTree(t *testing.T) {
	srv, _ := newServer(t)
	resp, err := srv.GetSnapshot(context.Background(), &localev1.SnapshotRequest{Lang: "fa", Scope: "backend"})
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if resp.Lang != "fa" || resp.Scope != "backend" {
		t.Errorf("echoed lang/scope = %q/%q, want fa/backend", resp.Lang, resp.Scope)
	}
	if resp.Version == "" {
		t.Error("version is empty; clients poll on it")
	}
	if got := resp.Namespaces["errors"].GetEntries()["auth.unauthorized"]; got != "دسترسی ندارید" {
		t.Errorf("auth.unauthorized = %q", got)
	}
}

func TestGetAvailableLocalesMapsEveryMetadataField(t *testing.T) {
	srv, _ := newServer(t)
	resp, err := srv.GetAvailableLocales(context.Background(), &localev1.Empty{})
	if err != nil {
		t.Fatalf("GetAvailableLocales: %v", err)
	}
	if len(resp.Locales) != 2 {
		t.Fatalf("got %d locales, want 2", len(resp.Locales))
	}
	fa := resp.Locales[1]
	if fa.Code != "fa" || fa.Name != "Persian" || fa.Dir != "rtl" || fa.Locale != "fa-IR" {
		t.Errorf("fa = %+v, want every metadata field carried across", fa)
	}
}

// --- the Watch broadcaster ---------------------------------------------

// fakeStream is a LocaleService_WatchServer that records what was sent and
// ends when its context is cancelled.
type fakeStream struct {
	localev1.LocaleService_WatchServer
	ctx  context.Context
	mu   sync.Mutex
	sent []*localev1.UpdateEvent
	got  chan struct{}
}

func newFakeStream(ctx context.Context) *fakeStream {
	return &fakeStream{ctx: ctx, got: make(chan struct{}, 32)}
}

func (f *fakeStream) Context() context.Context     { return f.ctx }
func (f *fakeStream) SetHeader(metadata.MD) error  { return nil }
func (f *fakeStream) SendHeader(metadata.MD) error { return nil }
func (f *fakeStream) SetTrailer(metadata.MD)       {}
func (f *fakeStream) SendMsg(any) error            { return nil }
func (f *fakeStream) RecvMsg(any) error            { return nil }

func (f *fakeStream) Send(ev *localev1.UpdateEvent) error {
	f.mu.Lock()
	f.sent = append(f.sent, ev)
	f.mu.Unlock()
	f.got <- struct{}{}
	return nil
}

func (f *fakeStream) events() []*localev1.UpdateEvent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*localev1.UpdateEvent(nil), f.sent...)
}

// waitFor blocks until n events have been sent or the deadline passes.
func (f *fakeStream) waitFor(t *testing.T, n int) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for i := 0; i < n; i++ {
		select {
		case <-f.got:
		case <-deadline:
			t.Fatalf("timed out waiting for event %d of %d (got %d)", i+1, n, len(f.events()))
		}
	}
}

// subscribe starts Watch in the background and returns the stream plus a
// cancel that ends it.
func subscribe(t *testing.T, srv *Server, req *localev1.WatchRequest) (*fakeStream, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	stream := newFakeStream(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Watch(req, stream)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("Watch did not return after its context was cancelled")
		}
	})
	// Give Watch a moment to register before the first broadcast.
	waitForSubscribers(t, srv, 1)
	return stream, cancel
}

func waitForSubscribers(t *testing.T, srv *Server, want int) {
	t.Helper()
	for i := 0; i < 200; i++ {
		srv.mu.RLock()
		n := len(srv.subscribers)
		srv.mu.RUnlock()
		if n >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("only %d subscribers registered, want %d", len(srv.subscribers), want)
}

// The first OnStoreChange is the boot reload: every version is new, so every
// subscriber is told once. The second, with nothing edited, must be silent.
func TestOnStoreChangeOnlyBroadcastsWhenTheVersionMoved(t *testing.T) {
	srv, root := newServer(t)
	stream, _ := subscribe(t, srv, &localev1.WatchRequest{Scope: "backend"})

	srv.OnStoreChange()
	stream.waitFor(t, 2) // en and fa

	srv.OnStoreChange()
	srv.OnStoreChange()
	time.Sleep(100 * time.Millisecond)
	if got := len(stream.events()); got != 2 {
		t.Fatalf("%d events after reloads that changed nothing, want 2", got)
	}

	// Now actually edit one language.
	writeTree(t, root, map[string]string{
		"backend/langs/fa/errors.json": `{"auth":{"unauthorized":"اجازه ندارید"}}`,
	})
	if err := srv.store.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	srv.OnStoreChange()
	stream.waitFor(t, 1)

	events := stream.events()
	last := events[len(events)-1]
	if last.Lang != "fa" {
		t.Errorf("edited fa but the event was for %q", last.Lang)
	}
	if len(events) != 3 {
		t.Errorf("%d events total, want 3 — en must not be re-broadcast when only fa changed", len(events))
	}
	// The event carries the whole snapshot so a client never has to follow up
	// with a GetSnapshot round-trip.
	if got := last.FullSnapshot.GetNamespaces()["errors"].GetEntries()["auth.unauthorized"]; got != "اجازه ندارید" {
		t.Errorf("event snapshot has %q, want the new value", got)
	}
	if last.NewVersion != last.FullSnapshot.GetVersion() {
		t.Errorf("NewVersion %q != snapshot version %q", last.NewVersion, last.FullSnapshot.GetVersion())
	}
}

// A subscriber asking for one scope must not be woken by another scope's
// changes — a backend service does not want the frontend's string table.
func TestWatchFiltersByScope(t *testing.T) {
	srv, _ := newServer(t)
	backend, _ := subscribe(t, srv, &localev1.WatchRequest{Scope: "backend"})
	frontend, _ := subscribe(t, srv, &localev1.WatchRequest{Scope: "frontend"})
	waitForSubscribers(t, srv, 2)

	srv.OnStoreChange()
	backend.waitFor(t, 2)  // en, fa
	frontend.waitFor(t, 2) // en, fa — frontend scope falls back to shareds for fa
	time.Sleep(50 * time.Millisecond)

	for _, ev := range backend.events() {
		if ev.Scope != "backend" {
			t.Errorf("backend subscriber received a %q event", ev.Scope)
		}
	}
	for _, ev := range frontend.events() {
		if ev.Scope != "frontend" {
			t.Errorf("frontend subscriber received a %q event", ev.Scope)
		}
	}
}

// langs on the request is a filter, and an empty list means "every language".
func TestWatchFiltersByLanguage(t *testing.T) {
	srv, _ := newServer(t)
	onlyFa, _ := subscribe(t, srv, &localev1.WatchRequest{Scope: "backend", Langs: []string{"fa"}})
	all, _ := subscribe(t, srv, &localev1.WatchRequest{Scope: "backend"})
	waitForSubscribers(t, srv, 2)

	srv.OnStoreChange()
	all.waitFor(t, 2)
	onlyFa.waitFor(t, 1)
	time.Sleep(50 * time.Millisecond)

	got := onlyFa.events()
	if len(got) != 1 || got[0].Lang != "fa" {
		t.Errorf("filtered subscriber got %d events (%v), want only fa", len(got), langsOf(got))
	}
	if want := []string{"en", "fa"}; len(all.events()) != 2 {
		t.Errorf("unfiltered subscriber got %v, want %v", langsOf(all.events()), want)
	}
}

// An empty string in langs is not a language; it must be dropped rather than
// becoming a filter that matches nothing.
func TestWatchIgnoresBlankLanguageFilters(t *testing.T) {
	srv, _ := newServer(t)
	stream, _ := subscribe(t, srv, &localev1.WatchRequest{Scope: "backend", Langs: []string{"", "en"}})

	srv.OnStoreChange()
	stream.waitFor(t, 1)
	time.Sleep(50 * time.Millisecond)

	got := stream.events()
	if len(got) != 1 || got[0].Lang != "en" {
		t.Errorf("got %v, want only en", langsOf(got))
	}
}

// A subscriber that goes away must be unregistered, or the broadcaster keeps
// filling a channel nobody reads for the life of the process.
func TestWatchUnregistersOnDisconnect(t *testing.T) {
	srv, _ := newServer(t)
	_, cancel := subscribe(t, srv, &localev1.WatchRequest{Scope: "backend"})

	cancel()
	for i := 0; i < 200; i++ {
		srv.mu.RLock()
		n := len(srv.subscribers)
		srv.mu.RUnlock()
		if n == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Error("subscriber was still registered after its stream context was cancelled")
}

// The send is non-blocking with a 16-deep buffer: a stalled consumer must not
// hold up the broadcast to everyone else, even if that costs it events.
func TestOnStoreChangeDoesNotBlockOnASlowSubscriber(t *testing.T) {
	srv, _ := newServer(t)
	// A subscriber registered directly, never draining its channel.
	stalled := &subscriber{scope: "backend", ch: make(chan *localev1.UpdateEvent, 1)}
	srv.mu.Lock()
	srv.subscribers[stalled] = struct{}{}
	srv.mu.Unlock()

	live, _ := subscribe(t, srv, &localev1.WatchRequest{Scope: "backend"})
	waitForSubscribers(t, srv, 2)

	done := make(chan struct{})
	go func() {
		srv.OnStoreChange()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("OnStoreChange blocked on a subscriber that is not reading")
	}
	live.waitFor(t, 2)
}

func TestWatchReturnsTheContextError(t *testing.T) {
	srv, _ := newServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := srv.Watch(&localev1.WatchRequest{Scope: "backend"}, newFakeStream(ctx))
	if err != context.Canceled {
		t.Errorf("Watch() = %v, want context.Canceled", err)
	}
}

func langsOf(events []*localev1.UpdateEvent) []string {
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, e.Lang)
	}
	sort.Strings(out)
	return out
}
