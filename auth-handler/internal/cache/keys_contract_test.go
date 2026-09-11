package cache

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Go half of the key-name contract (ADR-0036, C-03).
//
// `shared-core/src/lib/redis/keys.spec.ts` asserts the same cases against the
// TypeScript builders. Nothing joins the two languages, which is the whole
// problem: a `session:` built differently here than in the service that wrote
// it does not fail — the lookup misses, the miss is read as "revoked", and
// every request 401s while the sessions sit there under a slightly different
// name. That reads as a mass logout and is actually a total outage.
const keysFixturePath = "../../../contracts/redis/keyspace.json"

type keysFixture struct {
	KeyCases []struct {
		Builder string `json:"builder"`
		ID      string `json:"id"`
		Key     string `json:"key"`
	} `json:"keyCases"`
}

func TestContractKeyNames(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(keysFixturePath))
	if err != nil {
		t.Fatalf("read fixture %s: %v", keysFixturePath, err)
	}
	var fixture keysFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(fixture.KeyCases) == 0 {
		t.Fatalf("fixture %s declares no key cases", keysFixturePath)
	}

	builders := map[string]func(prefix, id string) string{
		"session":      SessionKey,
		"otpChannel":   OtpChannelKey,
		"userSessions": UserSessionsKey,
	}

	const prefix = "txnet:auth:v2:"
	seen := map[string]bool{}

	for _, tc := range fixture.KeyCases {
		build, ok := builders[tc.Builder]
		if !ok {
			t.Errorf("fixture declares builder %q, which keys.go does not have",
				tc.Builder)
			continue
		}
		seen[tc.Builder] = true

		want := prefix + tc.Key
		if got := build(prefix, tc.ID); got != want {
			t.Errorf("%s(%q) = %q, fixture says %q", tc.Builder, tc.ID, got, want)
		}
	}

	// The other direction: a builder here that the fixture does not declare is
	// a key name only one language knows about, which is how the four
	// catalogues drifted in the first place.
	for name := range builders {
		if !seen[name] {
			t.Errorf("keys.go has builder %q, which %s does not declare",
				name, keysFixturePath)
		}
	}
}

// A key builder's whole job is producing a string with the prefix on the front.
// Asserting it separately keeps the failure legible: a prefix that went missing
// and a name that changed shape are different bugs with the same symptom.
func TestKeysCarryThePrefix(t *testing.T) {
	for _, got := range []string{
		SessionKey("txnet:auth:v2:", "s1"),
		OtpChannelKey("txnet:auth:v2:", "c1"),
		UserSessionsKey("txnet:auth:v2:", "u1"),
	} {
		if !strings.HasPrefix(got, "txnet:auth:v2:") {
			t.Errorf("%q does not carry the keyspace prefix", got)
		}
	}
}
