package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The Go half of the keyspace contract (ADR-0036, C-03).
//
// `contracts/redis/keyspace.json` is hand-written and language-neutral;
// `shared-core/src/lib/redis/keyspace.contract.spec.ts` holds the TypeScript
// half to it and this file holds the Go half.
//
// It replaces a TypeScript transcription of `buildRedisKeyPrefix` that used to
// live inside a Node spec. That arrangement tested that two TypeScript
// functions agreed, which was never the risk: the only drift that matters is
// this file drifting from that one, and a transcription in the other language
// cannot see it.
const keyspaceFixturePath = "../../../contracts/redis/keyspace.json"

type keyspaceFixture struct {
	NamespaceDefault string `json:"namespaceDefault"`
	Version          string `json:"version"`
	PrefixCases      []struct {
		Namespace string `json:"namespace"`
		Version   string `json:"version"`
		Prefix    string `json:"prefix"`
	} `json:"prefixCases"`
}

func loadKeyspaceFixture(t *testing.T) keyspaceFixture {
	t.Helper()

	raw, err := os.ReadFile(filepath.Clean(keyspaceFixturePath))
	if os.IsNotExist(err) {
		t.Fatalf("keyspace fixture %s is missing — it is hand-written and "+
			"checked in; restore it rather than regenerating it", keyspaceFixturePath)
	}
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var fixture keyspaceFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(fixture.PrefixCases) == 0 {
		t.Fatalf("fixture %s declares no prefix cases", keyspaceFixturePath)
	}
	return fixture
}

// The defaults are the half that actually broke. A gateway defaulting `v1`
// while every service defaults `v2` reads a keyspace nobody writes, and every
// request it gates is answered "session revoked" — a total outage that looks
// like a mass logout.
func TestContractKeyspaceDefaults(t *testing.T) {
	fixture := loadKeyspaceFixture(t)

	if fixture.NamespaceDefault != DefaultRedisKeyNamespace {
		t.Errorf("namespaceDefault = %q in the fixture, %q in config.go",
			fixture.NamespaceDefault, DefaultRedisKeyNamespace)
	}
	if fixture.Version != DefaultRedisKeyspaceVersion {
		t.Errorf("version = %q in the fixture, %q in config.go",
			fixture.Version, DefaultRedisKeyspaceVersion)
	}
}

func TestContractKeyspacePrefixCases(t *testing.T) {
	fixture := loadKeyspaceFixture(t)

	for _, tc := range fixture.PrefixCases {
		if got := buildRedisKeyPrefix(tc.Namespace, tc.Version); got != tc.Prefix {
			t.Errorf("buildRedisKeyPrefix(%q, %q) = %q, fixture says %q",
				tc.Namespace, tc.Version, got, tc.Prefix)
		}
	}
}

// Load() must reach the same prefix the fixture declares when nothing is set.
// The constants agreeing is not enough on its own: a Load() that read a
// different env var, or applied the default somewhere else, would still pass
// the test above.
func TestContractLoadUsesTheDeclaredDefaults(t *testing.T) {
	fixture := loadKeyspaceFixture(t)

	t.Setenv("REDIS_KEY_NAMESPACE", "")
	t.Setenv("REDIS_KEYSPACE_VERSION", "")
	t.Setenv("JWT_SECRET", "contract-test-secret")
	t.Setenv("REDIS_URL", "redis://localhost:6379")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() failed: %v", err)
	}

	want := fixture.NamespaceDefault + ":" + fixture.Version + ":"
	if cfg.RedisKeyPrefix != want {
		t.Errorf("RedisKeyPrefix = %q, fixture says %q", cfg.RedisKeyPrefix, want)
	}
}
