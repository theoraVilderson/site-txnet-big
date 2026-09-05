package config

import "testing"

// The prefix built here has a twin in TypeScript
// (auth-service/src/app/redis/redis.service.ts, asserted in redis.keys.spec.ts
// under "parity with auth-handler/internal/config/config.go"). Nothing at
// build time couples them, so each side pins its own behaviour and names the
// other: if this table changes, the Node parity test is the thing to change
// with it.
//
// The failure they exist to prevent is silent. A prefix that disagrees by one
// character does not error — the gateway simply finds no session key, and
// every authenticated request comes back `session_revoked`.
func TestBuildRedisKeyPrefix(t *testing.T) {
	tests := []struct {
		name      string
		namespace string
		version   string
		want      string
	}{
		{"the deployed default", "txnet:auth", "v1", "txnet:auth:v1:"},
		{"a bumped keyspace", "txnet:auth", "v2", "txnet:auth:v2:"},
		{"a single-segment namespace", "acme", "v7", "acme:v7:"},
		// auth-service's envSchema strips these before its own prefix is
		// assembled; Go strips them here. Both sides must, or a namespace
		// written with a trailing colon splits the keyspace in two.
		{"trailing colon stripped", "txnet:auth:", "v1", "txnet:auth:v1:"},
		{"several trailing colons stripped", "txnet:auth::", "v1", "txnet:auth:v1:"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := buildRedisKeyPrefix(tc.namespace, tc.version); got != tc.want {
				t.Errorf("buildRedisKeyPrefix(%q, %q) = %q, want %q",
					tc.namespace, tc.version, got, tc.want)
			}
		})
	}
}

func TestBuildRedisKeyPrefixKeepsInnerColons(t *testing.T) {
	// Only the trailing separator is noise; the colons inside the namespace
	// are what make it a namespace.
	if got := buildRedisKeyPrefix("txnet:auth:eu", "v1"); got != "txnet:auth:eu:v1:" {
		t.Errorf("got %q, want %q", got, "txnet:auth:eu:v1:")
	}
}

func TestLoadDefaultsTheRedisKeyPrefix(t *testing.T) {
	// Load() is what production actually calls; the default has to survive it,
	// since neither compose file sets REDIS_KEY_NAMESPACE explicitly in dev.
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("REDIS_URL", "redis://127.0.0.1:6379")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RedisKeyPrefix != "txnet:auth:v1:" {
		t.Errorf("RedisKeyPrefix = %q, want %q", cfg.RedisKeyPrefix, "txnet:auth:v1:")
	}
}

func TestLoadUsesConfiguredNamespaceAndVersion(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("REDIS_URL", "redis://127.0.0.1:6379")
	t.Setenv("REDIS_KEY_NAMESPACE", "txnet:auth:")
	t.Setenv("REDIS_KEYSPACE_VERSION", "v3")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RedisKeyPrefix != "txnet:auth:v3:" {
		t.Errorf("RedisKeyPrefix = %q, want %q", cfg.RedisKeyPrefix, "txnet:auth:v3:")
	}
}
