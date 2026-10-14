package config

import (
	"strings"
	"testing"
)

const (
	someDSN    = "postgresql://txnet_cross_tenant_user:pw@db-pool:6432/txnet"
	someListen = "postgresql://txnet_cross_tenant_user:pw@main-db:5432/txnet"
	someRedis  = "redis://memory-data:6379"
)

// LISTEN through db-pool's transaction mode loses every notification without
// an error (hosting H8), and a lost one is a stale /sub render for an hour, so
// the listener's direct URL has no fallback to the pooled one.
func TestLoadRefusesAMissingListenURL(t *testing.T) {
	t.Setenv("DATABASE_CROSS_TENANT_URL", someDSN)
	t.Setenv("REDIS_URL", someRedis)
	t.Setenv("DATABASE_LISTEN_URL", "")

	_, err := Load()

	if err == nil {
		t.Fatal("Load() = nil error, want a refusal")
	}
	if !strings.Contains(err.Error(), "DATABASE_LISTEN_URL") {
		t.Errorf("refusal %q does not name the variable", err)
	}
}

// The default pool is hosting H8's budget, so a deploy that sets nothing
// still fits Postgres's max_connections behind db-pool.
func TestLoadDefaultPoolFitsTheConnectionBudget(t *testing.T) {
	t.Setenv("DATABASE_CROSS_TENANT_URL", someDSN)
	t.Setenv("REDIS_URL", someRedis)
	t.Setenv("DATABASE_LISTEN_URL", someListen)

	cfg, err := Load()

	if err != nil {
		t.Fatalf("Load() = %v, want nil", err)
	}
	if cfg.PoolMaxConns != 5 || cfg.DatabaseListenURL != someListen {
		t.Errorf("PoolMaxConns = %d, DatabaseListenURL = %q; want 5 and the listen URL", cfg.PoolMaxConns, cfg.DatabaseListenURL)
	}
}
