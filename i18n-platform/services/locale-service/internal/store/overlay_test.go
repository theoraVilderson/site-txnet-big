package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The runtime overlay (F-1533-b, ADR-0050) is the only place locale-service
// accepts a write. Its rules are the ones a caller cannot see from outside:
// an overlay entry wins over locales/ per key (not per file), a draft is never
// served, publishing moves a draft rather than copying it, and a write lands on
// disk so a restart keeps it.

func overlayStore(t *testing.T) (*Store, string) {
	t.Helper()
	root, runtime := t.TempDir(), t.TempDir()
	write(t, root, sampleTree())
	s := NewWithRuntime(root, runtime)
	if err := s.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	return s, runtime
}

func entry(t *testing.T, s *Store, lang, scope, ns, key string) (string, bool) {
	t.Helper()
	namespaces, _, ok := s.Snapshot(lang, scope)
	if !ok {
		t.Fatalf("Snapshot(%s, %s) not ok", lang, scope)
	}
	v, ok := namespaces[ns].Entries[key]
	return v, ok
}

func TestOverlayMergesPerKeyOverLocales(t *testing.T) {
	s, _ := overlayStore(t)
	if _, err := s.SetEntries(ScopeShareds, "en", "brand", map[string]string{"slogan": "Fast"}, Published); err != nil {
		t.Fatalf("SetEntries: %v", err)
	}
	if v, _ := entry(t, s, "en", ScopeBackend, "brand", "slogan"); v != "Fast" {
		t.Errorf("overlay entry = %q, want Fast", v)
	}
	if v, _ := entry(t, s, "en", ScopeBackend, "brand", "name"); v != "TXNet" {
		t.Errorf("locales/ entry in the same namespace = %q; the overlay replaced the file instead of merging per key", v)
	}

	if _, err := s.SetEntries(ScopeShareds, "en", "brand", map[string]string{"name": "Other"}, Published); err != nil {
		t.Fatalf("SetEntries: %v", err)
	}
	if v, _ := entry(t, s, "en", ScopeBackend, "brand", "name"); v != "Other" {
		t.Errorf("overlay did not win over locales/: %q", v)
	}
}

func TestDraftIsNeverInASnapshot(t *testing.T) {
	s, _ := overlayStore(t)
	_, before, _ := s.Snapshot("en", "")
	if _, err := s.SetEntries(ScopeShareds, "en", "catalog", map[string]string{"product.vpn.name": "VPN"}, Draft); err != nil {
		t.Fatalf("SetEntries: %v", err)
	}
	for _, scope := range []string{"", ScopeBackend, ScopeFrontend} {
		namespaces, _, _ := s.Snapshot("en", scope)
		for ns, data := range namespaces {
			if _, leaked := data.Entries["product.vpn.name"]; leaked {
				t.Errorf("draft served in scope %q namespace %q", scope, ns)
			}
		}
	}
	if _, after, _ := s.Snapshot("en", ""); after != before {
		t.Error("a draft moved the snapshot version; every client would refetch for nothing")
	}
	drafts := s.Drafts(ScopeShareds, "en", "catalog", "product.")
	if len(drafts) != 1 || drafts[0].Text != "VPN" || drafts[0].Key != "product.vpn.name" {
		t.Errorf("Drafts = %+v", drafts)
	}
}

func TestPublishMovesTheDraft(t *testing.T) {
	s, runtime := overlayStore(t)
	if _, err := s.SetEntries(ScopeShareds, "en", "catalog", map[string]string{"a": "A", "b": "B"}, Draft); err != nil {
		t.Fatalf("SetEntries: %v", err)
	}
	n, err := s.PublishDrafts(ScopeShareds, "en", "catalog", []string{"a", "missing"})
	if err != nil || n != 1 {
		t.Fatalf("PublishDrafts = %d, %v; want 1 (a missing key is skipped)", n, err)
	}
	if v, _ := entry(t, s, "en", ScopeBackend, "catalog", "a"); v != "A" {
		t.Errorf("published a = %q", v)
	}
	if got := s.Drafts("", "", "", ""); len(got) != 1 || got[0].Key != "b" {
		t.Errorf("drafts after publish = %+v, want only b", got)
	}

	// Survives a restart: a fresh store over the same dirs sees the same state.
	fresh := NewWithRuntime(s.Root(), runtime)
	if err := fresh.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if v, _ := entry(t, fresh, "en", ScopeBackend, "catalog", "a"); v != "A" {
		t.Errorf("after restart a = %q", v)
	}
	if got := fresh.Drafts("", "", "", ""); len(got) != 1 {
		t.Errorf("after restart drafts = %+v", got)
	}
}

func TestPublishingAKeyDropsItsDraft(t *testing.T) {
	s, _ := overlayStore(t)
	_, _ = s.SetEntries(ScopeShareds, "en", "catalog", map[string]string{"a": "machine"}, Draft)
	if _, err := s.SetEntries(ScopeShareds, "en", "catalog", map[string]string{"a": "human"}, Published); err != nil {
		t.Fatalf("SetEntries: %v", err)
	}
	if got := s.Drafts("", "", "", ""); len(got) != 0 {
		t.Errorf("a stale draft outlived the published text: %+v", got)
	}
}

func TestEmptyValueDeletesTheOverlayKey(t *testing.T) {
	s, _ := overlayStore(t)
	_, _ = s.SetEntries(ScopeShareds, "en", "brand", map[string]string{"name": "Other", "x": "X"}, Published)
	if _, err := s.SetEntries(ScopeShareds, "en", "brand", map[string]string{"name": "", "x": ""}, Published); err != nil {
		t.Fatalf("SetEntries: %v", err)
	}
	if v, _ := entry(t, s, "en", ScopeBackend, "brand", "name"); v != "TXNet" {
		t.Errorf("after delete name = %q, want locales/ value back", v)
	}
	if _, ok := entry(t, s, "en", ScopeBackend, "brand", "x"); ok {
		t.Error("deleted key still served")
	}
}

func TestWritesAreRefused(t *testing.T) {
	root := t.TempDir()
	write(t, root, sampleTree())
	readOnly := New(root)
	_ = readOnly.Reload()
	if _, err := readOnly.SetEntries(ScopeShareds, "en", "catalog", map[string]string{"a": "A"}, Published); !errors.Is(err, ErrReadOnly) {
		t.Errorf("no runtime dir: err = %v, want ErrReadOnly", err)
	}

	s, runtime := overlayStore(t)
	cases := []struct {
		name            string
		scope, lang, ns string
		state           EntryState
		want            error
	}{
		{"unknown language", ScopeShareds, "de", "catalog", Published, ErrUnknownLang},
		{"unknown scope", "tenants", "en", "catalog", Published, ErrInvalid},
		{"path in namespace", ScopeShareds, "en", "../../etc", Published, ErrInvalid},
		{"metadata is not a namespace", ScopeShareds, "en", "metadata", Published, ErrInvalid},
		{"no state", ScopeShareds, "en", "catalog", 0, ErrInvalid},
	}
	for _, c := range cases {
		_, err := s.SetEntries(c.scope, c.lang, c.ns, map[string]string{"a": "A"}, c.state)
		if !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
	if _, err := os.Stat(filepath.Join(runtime, "shareds", "de")); !os.IsNotExist(err) {
		t.Error("a refused write left a directory behind")
	}
}

func TestOverlayCannotInventALanguage(t *testing.T) {
	root, runtime := t.TempDir(), t.TempDir()
	write(t, root, sampleTree())
	write(t, runtime, tree{"shareds/de/catalog.json": `{"a":"A"}`})
	s := NewWithRuntime(root, runtime)
	if err := s.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	for _, l := range s.Languages() {
		if l == "de" {
			t.Error("a language only present in the overlay was advertised; languages come from locales/")
		}
	}
}
