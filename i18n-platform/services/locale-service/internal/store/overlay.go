package store

// The runtime overlay (F-1533-b, ADR-0050 decisions 2-3).
//
// locales/ is git-tracked and mounted read-only; text written at runtime (a
// catalog name typed by an admin) lives in LOCALES_RUNTIME_DIR instead, with
// the same layout, and is merged over locales/ per key:
//
//	<runtime>/<scope layout as locales/>/<lang>/<namespace>.json          published — served
//	<runtime>/drafts/<scope layout as locales/>/<lang>/<namespace>.json   draft — never served
//
// Files are flat JSON objects (dot-notation keys). Languages come from
// locales/ only: the overlay can add text to a language, never a language.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// draftsDir is the subdirectory of the runtime dir that holds drafts.
const draftsDir = "drafts"

// EntryState says whether a runtime write is served (Published) or held for
// review (Draft).
type EntryState int

const (
	Published EntryState = iota + 1
	Draft
)

var (
	// ErrReadOnly: the store was built without a runtime dir.
	ErrReadOnly = errors.New("locale store is read-only: LOCALES_RUNTIME_DIR is not set")
	// ErrUnknownLang: the language has no directory in locales/.
	ErrUnknownLang = errors.New("unknown language")
	// ErrInvalid: a bad scope, namespace, key or state.
	ErrInvalid = errors.New("invalid write")
)

var namespaceRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// DraftEntry is one draft held for review.
type DraftEntry struct {
	Scope, Lang, Namespace, Key, Text string
}

// NewWithRuntime creates a Store that serves root with the writable overlay at
// runtime merged over it. An empty runtime is the same as New(root).
func NewWithRuntime(root, runtime string) *Store {
	s := New(root)
	s.runtime = runtime
	return s
}

// RuntimeDir returns the overlay directory ("" when read-only).
func (s *Store) RuntimeDir() string { return s.runtime }

// loadOverlay merges the runtime dir's published entries into loaded and sets
// its drafts. A language absent from locales/ is dropped, not invented.
func loadOverlay(loaded *Loaded, runtime string) error {
	published, err := loadAll(runtime)
	if err != nil {
		return fmt.Errorf("runtime overlay: %w", err)
	}
	drafts, err := loadAll(filepath.Join(runtime, draftsDir))
	if err != nil {
		return fmt.Errorf("runtime drafts: %w", err)
	}
	for scope, byLang := range published.byScope {
		for lang, nss := range byLang {
			if _, known := loaded.meta[lang]; !known {
				continue
			}
			for ns, data := range nss {
				if loaded.byScope[scope] == nil {
					loaded.byScope[scope] = map[string]map[string]Namespace{}
				}
				if loaded.byScope[scope][lang] == nil {
					loaded.byScope[scope][lang] = map[string]Namespace{}
				}
				merged, ok := loaded.byScope[scope][lang][ns]
				if !ok {
					merged = Namespace{Entries: map[string]string{}}
				}
				for k, v := range data.Entries {
					merged.Entries[k] = v
				}
				loaded.byScope[scope][lang][ns] = merged
			}
		}
	}
	loaded.drafts = drafts.byScope
	return nil
}

func (s *Store) validate(scope, lang, ns string) error {
	if s.runtime == "" {
		return ErrReadOnly
	}
	switch scope {
	case ScopeBackend, ScopeFrontend, ScopeShareds:
	default:
		return fmt.Errorf("%w: scope %q", ErrInvalid, scope)
	}
	if !namespaceRe.MatchString(ns) || ns == "metadata" {
		return fmt.Errorf("%w: namespace %q", ErrInvalid, ns)
	}
	s.mu.RLock()
	_, known := s.loaded.meta[lang]
	s.mu.RUnlock()
	if !known {
		return fmt.Errorf("%w: %q", ErrUnknownLang, lang)
	}
	return nil
}

func (s *Store) overlayFile(scope, lang, ns string, state EntryState) string {
	base := s.runtime
	if state == Draft {
		base = filepath.Join(s.runtime, draftsDir)
	}
	return filepath.Join(scopeBase(base, scope), lang, ns+".json")
}

// SetEntries writes entries for one (scope, lang, namespace) in the given
// state and reloads. An empty value deletes that key from that state.
// Publishing a key also drops its draft. Returns the number of non-empty
// entries written.
func (s *Store) SetEntries(scope, lang, ns string, entries map[string]string, state EntryState) (int, error) {
	if state != Published && state != Draft {
		if s.runtime == "" {
			return 0, ErrReadOnly
		}
		return 0, fmt.Errorf("%w: state %d", ErrInvalid, state)
	}
	if err := s.validate(scope, lang, ns); err != nil {
		return 0, err
	}
	for k := range entries {
		if strings.TrimSpace(k) == "" {
			return 0, fmt.Errorf("%w: empty key", ErrInvalid)
		}
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	path := s.overlayFile(scope, lang, ns, state)
	current, err := readFlat(path)
	if err != nil {
		return 0, err
	}
	written := 0
	for k, v := range entries {
		if v == "" {
			delete(current, k)
			continue
		}
		current[k] = v
		written++
	}
	if err := writeFlat(path, current); err != nil {
		return 0, err
	}

	if state == Published {
		draftPath := s.overlayFile(scope, lang, ns, Draft)
		drafts, err := readFlat(draftPath)
		if err != nil {
			return 0, err
		}
		before := len(drafts)
		for k := range entries {
			delete(drafts, k)
		}
		if len(drafts) != before {
			if err := writeFlat(draftPath, drafts); err != nil {
				return 0, err
			}
		}
	}
	return written, s.Reload()
}

// Drafts lists held drafts; every empty filter matches all. Sorted by scope,
// lang, namespace, key.
func (s *Store) Drafts(scope, lang, ns, keyPrefix string) []DraftEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []DraftEntry{}
	for sc, byLang := range s.loaded.drafts {
		if scope != "" && sc != scope {
			continue
		}
		for l, nss := range byLang {
			if lang != "" && l != lang {
				continue
			}
			for n, data := range nss {
				if ns != "" && n != ns {
					continue
				}
				for k, v := range data.Entries {
					if strings.HasPrefix(k, keyPrefix) {
						out = append(out, DraftEntry{Scope: sc, Lang: l, Namespace: n, Key: k, Text: v})
					}
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Scope != b.Scope {
			return a.Scope < b.Scope
		}
		if a.Lang != b.Lang {
			return a.Lang < b.Lang
		}
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		return a.Key < b.Key
	})
	return out
}

// PublishDrafts moves the named drafts to published, as they are, and reloads.
// A key with no draft is skipped. Returns how many were published.
func (s *Store) PublishDrafts(scope, lang, ns string, keys []string) (int, error) {
	if err := s.validate(scope, lang, ns); err != nil {
		return 0, err
	}
	if len(keys) == 0 {
		return 0, fmt.Errorf("%w: no keys", ErrInvalid)
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	draftPath := s.overlayFile(scope, lang, ns, Draft)
	drafts, err := readFlat(draftPath)
	if err != nil {
		return 0, err
	}
	pubPath := s.overlayFile(scope, lang, ns, Published)
	published, err := readFlat(pubPath)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, k := range keys {
		if v, ok := drafts[k]; ok {
			published[k] = v
			delete(drafts, k)
			moved++
		}
	}
	if moved == 0 {
		return 0, nil
	}
	// Published first: a crash in between leaves a duplicate draft, never a
	// lost one.
	if err := writeFlat(pubPath, published); err != nil {
		return 0, err
	}
	if err := writeFlat(draftPath, drafts); err != nil {
		return 0, err
	}
	return moved, s.Reload()
}

// readFlat reads one overlay file as flat entries; a missing file is empty.
func readFlat(path string) (map[string]string, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var tree map[string]any
	if err := json.Unmarshal(raw, &tree); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	out := map[string]string{}
	flatten("", tree, out)
	return out, nil
}

// writeFlat replaces one overlay file atomically (temp file + rename); an
// empty map removes the file.
func writeFlat(path string, entries map[string]string) error {
	if len(entries) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(entries, "", "  ") // map keys are sorted
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return nil
}
