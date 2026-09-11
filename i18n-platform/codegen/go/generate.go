// locale-sdk-gen (Go) — generates typed key constants for one locale scope, so
// Go call sites reference a constant instead of a stringly-typed literal and a
// renamed key breaks the build (ADR-0036).
//
// Two sources:
//
//	go run . -dir=../../../locales -scope=backend -out=../../../auth-handler/internal/i18nkeys/keys_generated.go
//	LOCALE_SERVICE_ADDR=localhost:50051 go run . -scope=backend -out=...   (ad hoc, over gRPC)
//
// `-dir` reads `locales/<scope>/langs/<lang>/*.json` and `locales/shareds/<lang>`
// from disk with the same flatten and merge rules as locale-service, so it
// needs no running service and can be a CI gate. ADR-0003 is untouched: the
// service is the source of truth for serving, the files for what exists.
//
// **No silent false green.** `-dir` never keeps stale output when its source is
// unreadable, and `-strict` turns the gRPC path's fail-soft off too. Output is
// sorted and its header carries no timestamp or snapshot version, so the same
// `locales/` always produces the same bytes and `git diff --exit-code` is a
// real check rather than one that is always red or trained to be ignored.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"go/format"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	localeclient "github.com/txnet/i18n-platform/clients/go"
)

func main() {
	lang := flag.String("lang", "fa", "reference language (project standard: fa)")
	scope := flag.String("scope", "backend", "locale scope")
	dir := flag.String("dir", "", "locales root to read from disk (no locale-service needed)")
	out := flag.String("out", "./internal/i18nkeys/keys_generated.go", "output file")
	pkg := flag.String("package", "i18nkeys", "Go package name of the output")
	strict := flag.Bool("strict", false, "never keep stale output when the source is unreadable")
	addr := flag.String("addr", envOr("LOCALE_SERVICE_ADDR", "localhost:50051"), "locale-service address")
	flag.Parse()

	var (
		namespaces map[string]map[string]string
		err        error
	)
	if *dir != "" {
		namespaces, err = fromDisk(*dir, *scope, *lang)
	} else {
		namespaces, err = fromService(*addr, *scope, *lang)
	}
	if err != nil {
		if _, statErr := os.Stat(*out); statErr == nil && *dir == "" && !*strict {
			log.Printf("[locale-sdk-gen] source unreadable; keeping %s. (%v)", *out, err)
			return
		}
		log.Fatalf("[locale-sdk-gen] cannot read the %s scope: %v", *scope, err)
	}
	if len(namespaces) == 0 {
		log.Fatalf("[locale-sdk-gen] the %s scope has no namespaces — refusing to write an empty catalogue", *scope)
	}

	src, err := render(*pkg, *scope, *lang, namespaces)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*out, src, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("[locale-sdk-gen] wrote %s", *out)
}

func fromDisk(root, scope, lang string) (map[string]map[string]string, error) {
	scoped := filepath.Join(root, scope, "langs", lang)
	if _, err := os.Stat(scoped); err != nil {
		return nil, fmt.Errorf("no such locale directory: %s", scoped)
	}
	merged := map[string]map[string]string{}
	// Shareds first, then the named scope on top — the service's merge order.
	for _, path := range []string{filepath.Join(root, "shareds", lang), scoped} {
		files, err := os.ReadDir(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			name := f.Name()
			if f.IsDir() || !strings.HasSuffix(name, ".json") || name == "metadata.json" {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(path, name))
			if err != nil {
				return nil, err
			}
			var tree map[string]any
			if err := json.Unmarshal(raw, &tree); err != nil {
				return nil, fmt.Errorf("parse %s: %w", filepath.Join(path, name), err)
			}
			flat := map[string]string{}
			flatten("", tree, flat)
			merged[strings.TrimSuffix(name, ".json")] = flat
		}
	}
	return merged, nil
}

func fromService(addr, scope, lang string) (map[string]map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := localeclient.New(ctx, localeclient.Config{Addr: addr, Scope: scope})
	if err != nil {
		return nil, err
	}
	defer client.Close()
	s, err := client.Snapshot(ctx, lang)
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]string{}
	for ns, data := range s.GetNamespaces() {
		out[ns] = data.GetEntries()
	}
	return out, nil
}

// flatten turns {"a":{"b":"x"}} into {"a.b":"x"} — locale-service's store.go rule.
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
	case string, bool, float64:
		out[prefix] = fmt.Sprintf("%v", t)
	}
}

func render(pkg, scope, lang string, namespaces map[string]map[string]string) ([]byte, error) {
	names := make([]string, 0, len(namespaces))
	total := 0
	for ns := range namespaces {
		names = append(names, ns)
		total += len(namespaces[ns])
	}
	sort.Strings(names)

	var b strings.Builder
	fmt.Fprintf(&b, "// Code generated by i18n-platform/codegen/go/generate.go. DO NOT EDIT.\n")
	fmt.Fprintf(&b, "// Regenerate with `make -C i18n-platform i18n-keys`; CI fails when this is stale.\n")
	fmt.Fprintf(&b, "// scope: %s, reference language: %s, %d namespaces, %d keys.\n\n", scope, lang, len(names), total)
	fmt.Fprintf(&b, "// Package %s holds every translation key in the %s scope as a constant.\n", pkg, scope)
	fmt.Fprintf(&b, "// The value is the key itself; the constant's name is the namespace plus\n")
	fmt.Fprintf(&b, "// the key, so `ErrorsAuthInvalidToken` is `auth.invalidToken` in `errors`.\n")
	fmt.Fprintf(&b, "package %s\n", pkg)

	seen := map[string]string{}
	for _, ns := range names {
		keys := make([]string, 0, len(namespaces[ns]))
		for k := range namespaces[ns] {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		fmt.Fprintf(&b, "\n// Namespace%s names the %q namespace.\n", constName(ns, ""), ns)
		fmt.Fprintf(&b, "const Namespace%s = %q\n\n// Keys in %q.\nconst (\n", constName(ns, ""), ns, ns)
		for _, k := range keys {
			name := constName(ns, k)
			// Two keys that differ only in separators ("a.b" vs "a_b") would
			// collapse onto one identifier. Fail rather than pick one.
			if prev, dup := seen[name]; dup {
				return nil, fmt.Errorf("keys %q and %q both map to constant %s", prev, ns+"/"+k, name)
			}
			seen[name] = ns + "/" + k
			fmt.Fprintf(&b, "\t%s = %q\n", name, k)
		}
		fmt.Fprint(&b, ")\n")
	}
	return format.Source([]byte(b.String()))
}

func constName(ns, key string) string {
	parts := append(strings.FieldsFunc(ns, sep), strings.FieldsFunc(key, sep)...)
	var b strings.Builder
	for _, p := range parts {
		if p == "" {
			continue
		}
		b.WriteString(strings.ToUpper(p[:1]) + p[1:])
	}
	return b.String()
}

func sep(r rune) bool { return r == '.' || r == '/' || r == '-' || r == '_' }

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
