package store

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// The store is where the on-disk tree becomes the wire snapshot every client
// caches. Three of its rules are invisible in the code that calls it and
// expensive when wrong: the named scope wins over shareds on a key collision,
// the version hash is content-addressed (so it must not move when nothing
// changed, and must move when anything did), and a language with no
// metadata.json is still served.

// --- fixture ------------------------------------------------------------

type tree map[string]string // relative path -> file content

func write(t *testing.T, root string, files tree) {
	t.Helper()
	for rel, content := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
}

// sampleTree mirrors the repo's locales/ layout: two named scopes with a
// langs/ level, shareds without one, and metadata per language.
func sampleTree() tree {
	return tree{
		"backend/langs/en/metadata.json":  `{"code":"en","name":"English","shortName":"EN","nativeName":"English","dir":"ltr","locale":"en-US"}`,
		"backend/langs/en/errors.json":    `{"auth":{"unauthorized":"Unauthorized","expired":"Session expired"}}`,
		"backend/langs/en/messages.json":  `{"ok":"Done"}`,
		"backend/langs/fa/metadata.json":  `{"code":"fa","name":"Persian","shortName":"FA","nativeName":"فارسی","dir":"rtl","locale":"fa-IR"}`,
		"backend/langs/fa/errors.json":    `{"auth":{"unauthorized":"دسترسی ندارید"}}`,
		"frontend/langs/en/common.json":   `{"submit":"Submit"}`,
		"frontend/langs/en/metadata.json": `{"code":"en","name":"English (frontend)","shortName":"EN","nativeName":"English","dir":"ltr","locale":"en-GB"}`,
		"shareds/en/errors.json":          `{"auth":{"unauthorized":"SHARED unauthorized","network":"Network error"}}`,
		"shareds/en/brand.json":           `{"name":"TXNet"}`,
	}
}

func loadedStore(t *testing.T, files tree) *Store {
	t.Helper()
	root := t.TempDir()
	write(t, root, files)
	s := New(root)
	if err := s.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	return s
}

// --- loading ------------------------------------------------------------

func TestReloadFlattensNestedNamespaces(t *testing.T) {
	s := loadedStore(t, sampleTree())

	namespaces, _, ok := s.Snapshot("fa", ScopeBackend)
	if !ok {
		t.Fatal("Snapshot(fa, backend) not ok")
	}
	errors, ok := namespaces["errors"]
	if !ok {
		t.Fatalf("errors namespace missing; got %v", keysOf(namespaces))
	}
	if got := errors.Entries["auth.unauthorized"]; got != "دسترسی ندارید" {
		t.Errorf("auth.unauthorized = %q, want the flattened dot-notation key to resolve", got)
	}
	if _, nested := errors.Entries["auth"]; nested {
		t.Error("the intermediate object was kept as an entry; only leaves are entries")
	}
}

// The named scope is the specific one; shareds is the fallback. A collision
// resolved the other way would have every service showing the generic string.
func TestSnapshotNamedScopeWinsOverShareds(t *testing.T) {
	s := loadedStore(t, sampleTree())

	namespaces, _, ok := s.Snapshot("en", ScopeBackend)
	if !ok {
		t.Fatal("Snapshot(en, backend) not ok")
	}
	if got := namespaces["errors"].Entries["auth.unauthorized"]; got != "Unauthorized" {
		t.Errorf("auth.unauthorized = %q, want the backend value to win over shareds", got)
	}
	// A key only shareds has must survive the merge rather than being
	// dropped when the named scope replaces the namespace wholesale.
	if got := namespaces["errors"].Entries["auth.network"]; got != "Network error" {
		t.Errorf("auth.network = %q, want the shareds-only key kept", got)
	}
	// A namespace only shareds has comes along too.
	if got := namespaces["brand"].Entries["name"]; got != "TXNet" {
		t.Errorf("brand.name = %q, want the shareds namespace included", got)
	}
	// The frontend scope must not leak into a backend snapshot.
	if _, leaked := namespaces["common"]; leaked {
		t.Error("the frontend `common` namespace leaked into the backend snapshot")
	}
}

// scope == "" is the "give me everything" request the CLI and codegen use;
// prefixing keeps two scopes' same-named namespaces apart.
func TestSnapshotEmptyScopePrefixesEveryNamespace(t *testing.T) {
	s := loadedStore(t, sampleTree())

	namespaces, _, ok := s.Snapshot("en", "")
	if !ok {
		t.Fatal("Snapshot(en, \"\") not ok")
	}
	want := []string{"backend/errors", "backend/messages", "frontend/common", "shareds/brand", "shareds/errors"}
	if got := keysOf(namespaces); !reflect.DeepEqual(got, want) {
		t.Errorf("namespaces = %v, want %v", got, want)
	}
	// Unmerged: each scope keeps its own value under its own prefix.
	if got := namespaces["shareds/errors"].Entries["auth.unauthorized"]; got != "SHARED unauthorized" {
		t.Errorf("shareds value = %q, want it kept unmerged under its prefix", got)
	}
}

func TestSnapshotUnknownLanguageIsNotOK(t *testing.T) {
	s := loadedStore(t, sampleTree())
	namespaces, version, ok := s.Snapshot("de", ScopeBackend)
	if ok {
		t.Error("Snapshot(de) = ok, want not ok for a language with no content")
	}
	if namespaces != nil || version != "" {
		t.Errorf("Snapshot(de) = (%v, %q), want a zero result", namespaces, version)
	}
}

// An unknown scope is not an error: the language exists, so the shareds
// fallback is still the right answer rather than a hard failure.
func TestSnapshotUnknownScopeStillServesShareds(t *testing.T) {
	s := loadedStore(t, sampleTree())
	namespaces, _, ok := s.Snapshot("en", "mobile")
	if !ok {
		t.Fatal("Snapshot(en, mobile) not ok; an unknown scope must fall back, not fail")
	}
	if got := namespaces["errors"].Entries["auth.unauthorized"]; got != "SHARED unauthorized" {
		t.Errorf("auth.unauthorized = %q, want the shareds value", got)
	}
}

// --- the version hash ---------------------------------------------------

// Clients poll the version and refetch when it moves. A hash that moved on
// its own would make every client refetch forever; one that did not move on a
// real edit would leave stale copy in production after a translation fix.
func TestSnapshotVersionIsContentAddressed(t *testing.T) {
	files := sampleTree()
	s := loadedStore(t, files)

	_, first, _ := s.Snapshot("en", ScopeBackend)
	_, again, _ := s.Snapshot("en", ScopeBackend)
	if first != again {
		t.Errorf("version moved between two reads of the same tree: %q vs %q", first, again)
	}
	if first == "" {
		t.Fatal("version is empty")
	}

	// A reload of an unchanged tree keeps the version.
	if err := s.Reload(); err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if _, afterReload, _ := s.Snapshot("en", ScopeBackend); afterReload != first {
		t.Errorf("version moved after reloading an unchanged tree: %q vs %q", afterReload, first)
	}

	// Editing one value must move it.
	changed := sampleTree()
	changed["backend/langs/en/errors.json"] = `{"auth":{"unauthorized":"Not allowed","expired":"Session expired"}}`
	other := loadedStore(t, changed)
	if _, edited, _ := other.Snapshot("en", ScopeBackend); edited == first {
		t.Error("version did not move after a translation was edited")
	}
}

// Two languages of the same scope must not share a version, or a client that
// caches per language would refuse to refetch the one that actually changed.
func TestSnapshotVersionIsPerLanguage(t *testing.T) {
	s := loadedStore(t, sampleTree())
	_, en, _ := s.Snapshot("en", ScopeBackend)
	_, fa, _ := s.Snapshot("fa", ScopeBackend)
	if en == fa {
		t.Error("en and fa share a version hash")
	}
}

// --- metadata -----------------------------------------------------------

func TestLanguagesAndLocalesAreSorted(t *testing.T) {
	s := loadedStore(t, sampleTree())

	if got := s.Languages(); !reflect.DeepEqual(got, []string{"en", "fa"}) {
		t.Errorf("Languages() = %v, want [en fa]", got)
	}
	locales := s.AvailableLocales()
	if len(locales) != 2 || locales[0].Code != "en" || locales[1].Code != "fa" {
		t.Fatalf("AvailableLocales() = %+v, want en then fa", locales)
	}
	if locales[1].Dir != "rtl" {
		t.Errorf("fa dir = %q, want rtl", locales[1].Dir)
	}
}

// Both scopes ship a metadata.json for en; the frontend one is the one the
// UI needs, so it has to win regardless of scope iteration order.
func TestFrontendMetadataWinsOverBackend(t *testing.T) {
	s := loadedStore(t, sampleTree())
	for _, m := range s.AvailableLocales() {
		if m.Code == "en" && m.Locale != "en-GB" {
			t.Errorf("en locale = %q, want the frontend metadata (en-GB) to win", m.Locale)
		}
	}
}

// A translator adding a language directory without metadata.json must not
// make that language invisible — it is served with a synthesised entry.
func TestLanguageWithoutMetadataIsStillServed(t *testing.T) {
	s := loadedStore(t, tree{
		"backend/langs/ar/errors.json": `{"auth":{"unauthorized":"غير مصرح"}}`,
	})

	if got := s.Languages(); !reflect.DeepEqual(got, []string{"ar"}) {
		t.Fatalf("Languages() = %v, want [ar]", got)
	}
	meta := s.AvailableLocales()[0]
	if meta.Code != "ar" || meta.ShortName != "AR" || meta.Dir != "ltr" {
		t.Errorf("synthesised meta = %+v, want code ar / short AR / dir ltr", meta)
	}
	if _, _, ok := s.Snapshot("ar", ScopeBackend); !ok {
		t.Error("Snapshot(ar) not ok for a language with content but no metadata")
	}
}

// metadata.json is a reserved filename, not a namespace; serving it as one
// would put the language's own metadata into every consumer's string table.
func TestReservedFilesAreNotNamespaces(t *testing.T) {
	s := loadedStore(t, tree{
		"backend/langs/en/metadata.json":      `{"code":"en","dir":"ltr"}`,
		"backend/langs/en/errors.json":        `{"a":"b"}`,
		"backend/langs/en/repomix-output.xml": `<not json>`,
		"backend/langs/en/notes.txt":          `not a namespace either`,
	})

	namespaces, _, _ := s.Snapshot("en", ScopeBackend)
	if got := keysOf(namespaces); !reflect.DeepEqual(got, []string{"errors"}) {
		t.Errorf("namespaces = %v, want only [errors]", got)
	}
}

// --- failure and edges ---------------------------------------------------

// A broken JSON file must fail the reload and leave the previous tree in
// place. Serving a half tree would blank out strings across the platform on
// a typo in one file.
func TestReloadKeepsThePreviousTreeOnAParseError(t *testing.T) {
	root := t.TempDir()
	write(t, root, sampleTree())
	s := New(root)
	if err := s.Reload(); err != nil {
		t.Fatalf("first Reload: %v", err)
	}
	_, before, _ := s.Snapshot("en", ScopeBackend)

	write(t, root, tree{"backend/langs/en/errors.json": `{"auth":{`})
	err := s.Reload()
	if err == nil {
		t.Fatal("Reload() on malformed JSON returned nil error")
	}
	if !strings.Contains(err.Error(), "errors.json") {
		t.Errorf("error = %q, want it to name the offending file", err)
	}

	namespaces, after, ok := s.Snapshot("en", ScopeBackend)
	if !ok {
		t.Fatal("the language disappeared after a failed reload")
	}
	if after != before {
		t.Errorf("version changed after a failed reload: %q -> %q", before, after)
	}
	if got := namespaces["errors"].Entries["auth.unauthorized"]; got != "Unauthorized" {
		t.Errorf("auth.unauthorized = %q, want the last good value", got)
	}
}

// A missing scope directory is normal — shareds is often empty — and must not
// fail the load of the scopes that are there.
func TestMissingScopeDirectoryIsNotAnError(t *testing.T) {
	s := loadedStore(t, tree{
		"backend/langs/en/errors.json": `{"a":"b"}`,
	})
	if _, _, ok := s.Snapshot("en", ScopeBackend); !ok {
		t.Error("Snapshot not ok with frontend/ and shareds/ absent")
	}
}

func TestReloadOfAMissingRootIsEmptyNotAnError(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "no-such-locales"))
	if err := s.Reload(); err != nil {
		t.Fatalf("Reload of a missing root = %v, want nil (every scope is optional)", err)
	}
	if got := s.Languages(); len(got) != 0 {
		t.Errorf("Languages() = %v, want empty", got)
	}
}

// Non-string scalars are stringified rather than dropped, so a count or a
// flag written into a locale file still reaches the client.
func TestFlattenStringifiesScalarsAndSkipsArrays(t *testing.T) {
	s := loadedStore(t, tree{
		"backend/langs/en/mixed.json": `{"text":"hi","count":3,"flag":true,"list":["a"],"nothing":null}`,
	})
	entries := mustNamespace(t, s, "en", ScopeBackend, "mixed").Entries

	want := map[string]string{"text": "hi", "count": "3", "flag": "true"}
	if !reflect.DeepEqual(entries, want) {
		t.Errorf("entries = %v, want %v (arrays and nulls skipped)", entries, want)
	}
}

// Snapshot hands out copies. A consumer mutating what it got must not corrupt
// the tree every other consumer reads from the same process.
func TestSnapshotReturnsACopy(t *testing.T) {
	s := loadedStore(t, sampleTree())

	first, _, _ := s.Snapshot("en", ScopeBackend)
	first["errors"].Entries["auth.unauthorized"] = "MUTATED"

	second, _, _ := s.Snapshot("en", ScopeBackend)
	if got := second["errors"].Entries["auth.unauthorized"]; got != "Unauthorized" {
		t.Errorf("auth.unauthorized = %q, want the store to be unaffected by a caller's mutation", got)
	}
}

// fsnotify is not recursive, so every per-language directory has to be listed
// or an edit to fa/errors.json fires no event and the reload never happens.
func TestWatchDirsCoversEveryLanguageDirectory(t *testing.T) {
	root := t.TempDir()
	write(t, root, sampleTree())
	s := New(root)

	got := s.WatchDirs()
	want := []string{
		root,
		filepath.Join(root, "backend", "langs"),
		filepath.Join(root, "backend", "langs", "en"),
		filepath.Join(root, "backend", "langs", "fa"),
		filepath.Join(root, "frontend", "langs"),
		filepath.Join(root, "frontend", "langs", "en"),
		filepath.Join(root, "shareds"),
		filepath.Join(root, "shareds", "en"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("WatchDirs() =\n%v\nwant\n%v", got, want)
	}
}

func TestWatchDirsSkipsWhatDoesNotExist(t *testing.T) {
	root := t.TempDir()
	write(t, root, tree{"backend/langs/en/errors.json": `{"a":"b"}`})
	for _, dir := range New(root).WatchDirs() {
		if _, err := os.Stat(dir); err != nil {
			t.Errorf("WatchDirs() returned %q which does not exist: %v", dir, err)
		}
	}
}

func TestRootIsReportedBack(t *testing.T) {
	root := t.TempDir()
	if got := New(root).Root(); got != root {
		t.Errorf("Root() = %q, want %q", got, root)
	}
}

// --- helpers ------------------------------------------------------------

func keysOf(m map[string]Namespace) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func mustNamespace(t *testing.T, s *Store, lang, scope, ns string) Namespace {
	t.Helper()
	namespaces, _, ok := s.Snapshot(lang, scope)
	if !ok {
		t.Fatalf("Snapshot(%s, %s) not ok", lang, scope)
	}
	n, ok := namespaces[ns]
	if !ok {
		t.Fatalf("namespace %q missing; got %v", ns, keysOf(namespaces))
	}
	return n
}
