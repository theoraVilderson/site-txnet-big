// Package store loads the on-disk translation tree and turns it into the wire
// snapshots served over gRPC.
//
// On-disk layout (the repo's `locales/` directory):
//
//	locales/backend/langs/<lang>/<namespace>.json
//	locales/frontend/langs/<lang>/<namespace>.json
//	locales/shareds/<lang>/<namespace>.json
//	locales/<scope>/langs/<lang>/metadata.json   (reserved: locale metadata, not a namespace)
//
// Every named scope ("backend" / "frontend") is always served together with the
// "shareds" namespaces so a consumer only has to preload a single scope.
package store

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Scope names.
const (
	ScopeBackend  = "backend"
	ScopeFrontend = "frontend"
	ScopeShareds  = "shareds"
)

// NamedScopes are the scopes a consumer may ask for directly.
var NamedScopes = []string{ScopeBackend, ScopeFrontend}

// reservedFiles are files inside a language directory that are not namespaces.
var reservedFiles = map[string]bool{
	"metadata.json":      true,
	"repomix-output.xml": true,
}

// Namespace is a flat map: dot-notation key -> raw text (may contain {{var}}).
type Namespace struct {
	Entries map[string]string
}

// LocaleMeta mirrors locales/<scope>/langs/<lang>/metadata.json.
type LocaleMeta struct {
	Code       string `json:"code"`
	Name       string `json:"name"`
	ShortName  string `json:"shortName"`
	NativeName string `json:"nativeName"`
	Dir        string `json:"dir"`
	Locale     string `json:"locale"`
}

// Loaded is an immutable view of the whole tree at one point in time.
type Loaded struct {
	// scope -> lang -> namespace -> Namespace
	byScope map[string]map[string]map[string]Namespace
	// lang -> metadata
	meta map[string]LocaleMeta
}

// Store holds the current Loaded tree behind a mutex and reloads it on demand.
type Store struct {
	root string

	mu     sync.RWMutex
	loaded Loaded
}

// New creates a Store rooted at the given `locales/` directory. Call Reload
// before serving.
func New(root string) *Store {
	return &Store{root: root, loaded: Loaded{
		byScope: map[string]map[string]map[string]Namespace{},
		meta:    map[string]LocaleMeta{},
	}}
}

// Root returns the locales directory being served.
func (s *Store) Root() string { return s.root }

// Reload reads the whole tree from disk and atomically swaps it in. On error the
// previous tree is kept.
func (s *Store) Reload() error {
	loaded, err := loadAll(s.root)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.loaded = loaded
	s.mu.Unlock()
	return nil
}

// Languages returns the sorted list of language codes that have metadata.
func (s *Store) Languages() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.loaded.meta))
	for code := range s.loaded.meta {
		out = append(out, code)
	}
	sort.Strings(out)
	return out
}

// AvailableLocales returns locale metadata sorted by code.
func (s *Store) AvailableLocales() []LocaleMeta {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]LocaleMeta, 0, len(s.loaded.meta))
	for _, m := range s.loaded.meta {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Code < out[j].Code })
	return out
}

// Snapshot builds the namespace map + version hash for one (lang, scope).
//
//   - scope == "" merges every scope; namespace keys are prefixed "<scope>/".
//   - a named scope is merged with the "shareds" namespaces (named scope wins
//     on a per-key collision).
//
// ok is false when the language is unknown.
func (s *Store) Snapshot(lang, scope string) (namespaces map[string]Namespace, version string, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if _, known := s.loaded.meta[lang]; !known {
		return nil, "", false
	}

	namespaces = map[string]Namespace{}

	switch scope {
	case "":
		for _, sc := range []string{ScopeBackend, ScopeFrontend, ScopeShareds} {
			for ns, data := range s.loaded.scopeLang(sc, lang) {
				namespaces[sc+"/"+ns] = cloneNamespace(data)
			}
		}
	default:
		// shareds first, then the named scope on top (named scope wins).
		for ns, data := range s.loaded.scopeLang(ScopeShareds, lang) {
			namespaces[ns] = cloneNamespace(data)
		}
		for ns, data := range s.loaded.scopeLang(scope, lang) {
			if existing, dup := namespaces[ns]; dup {
				for k, v := range data.Entries {
					existing.Entries[k] = v
				}
				continue
			}
			namespaces[ns] = cloneNamespace(data)
		}
	}

	return namespaces, hashNamespaces(namespaces), true
}

func (l Loaded) scopeLang(scope, lang string) map[string]Namespace {
	if byLang, ok := l.byScope[scope]; ok {
		if nss, ok := byLang[lang]; ok {
			return nss
		}
	}
	return map[string]Namespace{}
}

func cloneNamespace(n Namespace) Namespace {
	out := Namespace{Entries: make(map[string]string, len(n.Entries))}
	for k, v := range n.Entries {
		out.Entries[k] = v
	}
	return out
}

// hashNamespaces is a deterministic sha1 over the sorted namespace/entry set.
func hashNamespaces(namespaces map[string]Namespace) string {
	h := sha1.New()
	names := make([]string, 0, len(namespaces))
	for ns := range namespaces {
		names = append(names, ns)
	}
	sort.Strings(names)
	for _, ns := range names {
		h.Write([]byte("\x00ns:" + ns + "\x00"))
		entries := namespaces[ns].Entries
		keys := make([]string, 0, len(entries))
		for k := range entries {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			h.Write([]byte(k + "=" + entries[k] + "\x01"))
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

// WatchDirs returns every directory that should be registered with fsnotify
// (fsnotify is not recursive).
func (s *Store) WatchDirs() []string {
	dirs := map[string]bool{s.root: true}
	for _, scope := range []string{ScopeBackend, ScopeFrontend, ScopeShareds} {
		base := scopeBase(s.root, scope)
		dirs[base] = true
		entries, err := os.ReadDir(base)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				dirs[filepath.Join(base, e.Name())] = true
			}
		}
	}
	out := make([]string, 0, len(dirs))
	for d := range dirs {
		if _, err := os.Stat(d); err == nil {
			out = append(out, d)
		}
	}
	sort.Strings(out)
	return out
}

// scopeBase returns the directory that holds per-language folders for a scope.
// backend/frontend nest an extra "langs/" level; shareds does not.
func scopeBase(root, scope string) string {
	if scope == ScopeShareds {
		return filepath.Join(root, scope)
	}
	return filepath.Join(root, scope, "langs")
}

func loadAll(root string) (Loaded, error) {
	loaded := Loaded{
		byScope: map[string]map[string]map[string]Namespace{},
		meta:    map[string]LocaleMeta{},
	}

	for _, scope := range []string{ScopeBackend, ScopeFrontend, ScopeShareds} {
		base := scopeBase(root, scope)
		langDirs, err := os.ReadDir(base)
		if err != nil {
			if os.IsNotExist(err) {
				continue // scope is optional (e.g. empty shareds/)
			}
			return Loaded{}, fmt.Errorf("read %s: %w", base, err)
		}

		byLang := map[string]map[string]Namespace{}
		for _, ld := range langDirs {
			if !ld.IsDir() || strings.HasPrefix(ld.Name(), ".") {
				continue
			}
			lang := ld.Name()
			langPath := filepath.Join(base, lang)

			files, err := os.ReadDir(langPath)
			if err != nil {
				return Loaded{}, fmt.Errorf("read %s: %w", langPath, err)
			}

			namespaces := map[string]Namespace{}
			for _, f := range files {
				if f.IsDir() {
					continue
				}
				name := f.Name()
				if name == "metadata.json" {
					if m, err := readMeta(filepath.Join(langPath, name), lang); err == nil {
						// frontend metadata wins over backend/shareds.
						if _, exists := loaded.meta[lang]; !exists || scope == ScopeFrontend {
							loaded.meta[lang] = m
						}
					} else {
						return Loaded{}, err
					}
					continue
				}
				if reservedFiles[name] || !strings.HasSuffix(name, ".json") {
					continue
				}

				raw, err := os.ReadFile(filepath.Join(langPath, name))
				if err != nil {
					return Loaded{}, err
				}
				var tree map[string]any
				if err := json.Unmarshal(raw, &tree); err != nil {
					return Loaded{}, fmt.Errorf("parse %s/%s/%s: %w", scope, lang, name, err)
				}
				flat := map[string]string{}
				flatten("", tree, flat)
				namespaces[strings.TrimSuffix(name, ".json")] = Namespace{Entries: flat}
			}
			byLang[lang] = namespaces
		}
		loaded.byScope[scope] = byLang
	}

	// Any language that has content but no metadata.json still gets a sane entry.
	for _, byLang := range loaded.byScope {
		for lang := range byLang {
			if _, ok := loaded.meta[lang]; !ok {
				loaded.meta[lang] = LocaleMeta{
					Code: lang, Name: lang, ShortName: strings.ToUpper(lang),
					NativeName: lang, Dir: "ltr", Locale: lang,
				}
			}
		}
	}

	return loaded, nil
}

func readMeta(path, lang string) (LocaleMeta, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return LocaleMeta{}, err
	}
	var m LocaleMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		return LocaleMeta{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if m.Code == "" {
		m.Code = lang
	}
	if m.Dir == "" {
		m.Dir = "ltr"
	}
	return m, nil
}

// flatten turns {"a":{"b":"x"}} into {"a.b":"x"}. Non-string scalars are
// stringified; arrays/nulls are skipped.
func flatten(prefix string, v any, out map[string]string) {
	switch t := v.(type) {
	case map[string]any:
		for k, child := range t {
			key := k
			if prefix != "" {
				key = prefix + "." + k
			}
			flatten(key, child, out)
		}
	case string:
		out[prefix] = t
	case bool:
		out[prefix] = fmt.Sprintf("%v", t)
	case float64:
		out[prefix] = fmt.Sprintf("%v", t)
	}
}
