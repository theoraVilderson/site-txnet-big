package watcher

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/txnet/i18n-platform/services/locale-service/internal/store"
)

// Live reload is the reason anything talks to locale-service instead of
// reading the JSON files directly, and the watcher is the only piece of it.
// Three behaviours are worth pinning: the initial reload happens before Watch
// returns (so the server never serves an empty tree), a burst of writes
// debounces into one reload, and a broken file does not fire onChange —
// the last good tree stays live instead of being replaced by nothing.

// counter records onChange calls and lets a test wait for the next one.
type counter struct {
	n    atomic.Int64
	mu   sync.Mutex
	bell chan struct{}
}

func newCounter() *counter { return &counter{bell: make(chan struct{}, 64)} }

func (c *counter) fn() func() {
	return func() {
		c.n.Add(1)
		c.mu.Lock()
		select {
		case c.bell <- struct{}{}:
		default:
		}
		c.mu.Unlock()
	}
}

func (c *counter) count() int { return int(c.n.Load()) }

// awaitChange waits for one more onChange call, or fails.
func (c *counter) awaitChange(t *testing.T) {
	t.Helper()
	select {
	case <-c.bell:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for a reload")
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// fixture builds a minimal locales tree and returns its root plus the path of
// the one namespace file tests edit.
func fixture(t *testing.T) (root, errorsPath string) {
	t.Helper()
	root = t.TempDir()
	errorsPath = filepath.Join(root, "backend", "langs", "en", "errors.json")
	writeFile(t, filepath.Join(root, "backend", "langs", "en", "metadata.json"), `{"code":"en","dir":"ltr"}`)
	writeFile(t, errorsPath, `{"auth":{"unauthorized":"Unauthorized"}}`)
	return root, errorsPath
}

func startWatch(t *testing.T, s *store.Store, onChange func()) {
	t.Helper()
	stop, err := Watch(s, onChange)
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	t.Cleanup(stop)
}

// Watch reloads and calls onChange before it returns, so main can register the
// gRPC service knowing the tree is already populated.
func TestWatchLoadsBeforeReturning(t *testing.T) {
	root, _ := fixture(t)
	s := store.New(root)
	c := newCounter()

	startWatch(t, s, c.fn())

	if c.count() != 1 {
		t.Errorf("onChange called %d times before Watch returned, want 1", c.count())
	}
	if _, _, ok := s.Snapshot("en", store.ScopeBackend); !ok {
		t.Error("the store was empty when Watch returned")
	}
}

// A tree that does not parse must fail Watch outright rather than starting a
// service that serves nothing.
func TestWatchFailsIfTheInitialLoadFails(t *testing.T) {
	root, errorsPath := fixture(t)
	writeFile(t, errorsPath, `{"broken":`)

	c := newCounter()
	stop, err := Watch(store.New(root), c.fn())
	if err == nil {
		stop()
		t.Fatal("Watch() on an unparseable tree returned nil error")
	}
	if c.count() != 0 {
		t.Errorf("onChange fired %d times despite the failed load", c.count())
	}
}

func TestWatchReloadsOnAnEdit(t *testing.T) {
	root, errorsPath := fixture(t)
	s := store.New(root)
	c := newCounter()
	startWatch(t, s, c.fn())
	c.awaitChange(t) // the initial load

	writeFile(t, errorsPath, `{"auth":{"unauthorized":"Not allowed"}}`)
	c.awaitChange(t)

	namespaces, _, ok := s.Snapshot("en", store.ScopeBackend)
	if !ok {
		t.Fatal("Snapshot not ok after the reload")
	}
	if got := namespaces["errors"].Entries["auth.unauthorized"]; got != "Not allowed" {
		t.Errorf("auth.unauthorized = %q, want the edited value", got)
	}
}

// An editor saving a file, a git checkout, or a `make sync` writes several
// files in a burst. Each one must not cost a full tree reload and a broadcast
// to every connected client.
func TestWatchDebouncesABurstOfWrites(t *testing.T) {
	root, _ := fixture(t)
	s := store.New(root)
	c := newCounter()
	startWatch(t, s, c.fn())
	c.awaitChange(t) // initial

	langDir := filepath.Join(root, "backend", "langs", "en")
	for i := 0; i < 8; i++ {
		writeFile(t, filepath.Join(langDir, "errors.json"), `{"auth":{"unauthorized":"v`+string(rune('a'+i))+`"}}`)
		time.Sleep(10 * time.Millisecond) // well inside the 300ms debounce
	}
	c.awaitChange(t)
	// Let any second timer that was going to fire, fire.
	time.Sleep(2 * debounce)

	if got := c.count(); got != 2 {
		t.Errorf("onChange called %d times for one burst, want 2 (initial + one debounced reload)", got)
	}
}

// A save that leaves the file mid-write, or a bad translation commit, must not
// blank the tree: the reload fails, onChange is skipped, and the last good
// snapshot keeps being served.
func TestWatchKeepsTheLastGoodTreeWhenAReloadFails(t *testing.T) {
	root, errorsPath := fixture(t)
	s := store.New(root)
	c := newCounter()
	startWatch(t, s, c.fn())
	c.awaitChange(t)
	_, goodVersion, _ := s.Snapshot("en", store.ScopeBackend)

	writeFile(t, errorsPath, `{"auth": {`)
	time.Sleep(3 * debounce)

	if got := c.count(); got != 1 {
		t.Errorf("onChange called %d times, want 1 — a failed reload must not notify clients", got)
	}
	namespaces, version, ok := s.Snapshot("en", store.ScopeBackend)
	if !ok {
		t.Fatal("the language disappeared after a failed reload")
	}
	if version != goodVersion {
		t.Errorf("version moved to %q on a failed reload, want %q", version, goodVersion)
	}
	if got := namespaces["errors"].Entries["auth.unauthorized"]; got != "Unauthorized" {
		t.Errorf("auth.unauthorized = %q, want the last good value", got)
	}

	// And a later good write recovers without a restart.
	writeFile(t, errorsPath, `{"auth":{"unauthorized":"Recovered"}}`)
	c.awaitChange(t)
	namespaces, _, _ = s.Snapshot("en", store.ScopeBackend)
	if got := namespaces["errors"].Entries["auth.unauthorized"]; got != "Recovered" {
		t.Errorf("auth.unauthorized = %q, want the watcher to recover after a bad file", got)
	}
}

// fsnotify is not recursive: a language added after boot is in a directory
// nothing is watching yet, so the Create handler has to re-register.
func TestWatchPicksUpANewLanguageDirectory(t *testing.T) {
	root, _ := fixture(t)
	s := store.New(root)
	c := newCounter()
	startWatch(t, s, c.fn())
	c.awaitChange(t)

	faDir := filepath.Join(root, "backend", "langs", "fa")
	if err := os.MkdirAll(faDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	c.awaitChange(t) // the directory create itself triggers a reload

	writeFile(t, filepath.Join(faDir, "errors.json"), `{"auth":{"unauthorized":"دسترسی ندارید"}}`)
	c.awaitChange(t)

	deadline := time.After(3 * time.Second)
	for {
		if namespaces, _, ok := s.Snapshot("fa", store.ScopeBackend); ok {
			if got := namespaces["errors"].Entries["auth.unauthorized"]; got == "دسترسی ندارید" {
				return
			}
		}
		select {
		case <-deadline:
			t.Fatal("a language directory created after boot was never picked up")
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// stop() has to end the goroutine and close the fsnotify watcher; a later
// write must not reload into a store the process has finished with.
func TestStopEndsTheWatch(t *testing.T) {
	root, errorsPath := fixture(t)
	s := store.New(root)
	c := newCounter()

	stop, err := Watch(s, c.fn())
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	c.awaitChange(t)
	stop()

	writeFile(t, errorsPath, `{"auth":{"unauthorized":"After stop"}}`)
	time.Sleep(3 * debounce)

	if got := c.count(); got != 1 {
		t.Errorf("onChange called %d times after stop(), want 1", got)
	}
}
