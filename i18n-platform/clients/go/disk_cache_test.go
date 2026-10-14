package localeclient

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	"github.com/txnet/i18n-platform/clients/go/localev1"
)

// The disk cache (hosting H17). Twins of the three "disk cache" cases in
// clients/node/client.test.mjs; both clients write the same files into the
// same volume, so a file one saves is a file the other boots from.

// unreachable is an address nothing listens on: the TCP connect is refused at once.
const unreachable = "127.0.0.1:1"

// syncBuffer is a log sink safe for the client's goroutines and the test's read.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestEverySnapshotIsSavedWholeAndAtomically(t *testing.T) {
	dir := t.TempDir()
	newClient(t, serve(t, twoLanguageService()), Config{
		Scope: "backend", PreloadLangs: []string{"en", "fa"}, CacheDir: dir,
	})

	raw, err := os.ReadFile(filepath.Join(dir, "backend.en.json"))
	if err != nil {
		t.Fatalf("backend.en.json not saved: %v", err)
	}
	var saved localev1.SnapshotResponse
	if err := protojson.Unmarshal(raw, &saved); err != nil {
		t.Fatalf("saved file is not a snapshot: %v", err)
	}
	if got := saved.GetNamespaces()["errors"].GetEntries()["auth.unauthorized"]; got != "Unauthorized" {
		t.Errorf("saved en entry = %q, want Unauthorized", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "backend.fa.json")); err != nil {
		t.Errorf("backend.fa.json not saved: %v", err)
	}
	if info, err := os.Stat(filepath.Join(dir, "backend.en.json")); err == nil && info.Mode().Perm() != cacheFileMode {
		t.Errorf("saved file mode = %v, want %v so a service of another user reads it", info.Mode().Perm(), os.FileMode(cacheFileMode))
	}
	if tmp, _ := filepath.Glob(filepath.Join(dir, "*.tmp")); len(tmp) != 0 {
		t.Errorf("temp files left behind: %v", tmp)
	}
}

// The file is written the way the Node client writes it (JSON.stringify of the
// proto-loader object), so a Go boot reads what a Node service saved.
func TestBootsFromTheSavedSnapshotsWhenLocaleServiceIsUnreachable(t *testing.T) {
	dir := t.TempDir()
	nodeSaved := `{"namespaces":{"errors":{"entries":{"auth.unauthorized":"Unauthorized"}}},"lang":"en","scope":"backend","version":"v1"}`
	if err := os.WriteFile(filepath.Join(dir, "backend.en.json"), []byte(nodeSaved), 0o644); err != nil {
		t.Fatal(err)
	}
	logs := &syncBuffer{}

	c, err := New(context.Background(), Config{
		Addr: unreachable, Scope: "backend", PreloadLangs: []string{"en"},
		BootTimeout: 800 * time.Millisecond, CacheDir: dir,
		Logger: slog.New(slog.NewTextHandler(logs, nil)),
	})
	if err != nil {
		t.Fatalf("New() = %v, want a client booted from the cache", err)
	}
	t.Cleanup(func() { _ = c.Close() })

	if got := c.Translate("en", "errors", "auth.unauthorized"); got != "Unauthorized" {
		t.Errorf("Translate() = %q, want the saved text", got)
	}
	if got := c.DefaultLang(); got != "en" {
		t.Errorf("DefaultLang() = %q, want en", got)
	}
	if !strings.Contains(logs.String(), "booted from cache") {
		t.Errorf("no 'booted from cache' warning in:\n%s", logs)
	}
}

func TestWithNoSavedSnapshotAnUnreachableServiceStillFailsTheBoot(t *testing.T) {
	_, err := New(context.Background(), Config{
		Addr: unreachable, Scope: "backend", PreloadLangs: []string{"en"},
		BootTimeout: 800 * time.Millisecond, CacheDir: t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "boot failed") {
		t.Fatalf("New() = %v, want the boot to fail", err)
	}
}
