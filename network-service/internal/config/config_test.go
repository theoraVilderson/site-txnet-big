package config

import (
	"strings"
	"testing"
	"time"

	"network-service/internal/publish"
)

const (
	someDSN    = "postgresql://txnet_cross_tenant_user:pw@main-db:5432/txnet"
	someBroker = "amqp://admin:pw@rabbitmq:5672"
)

func TestLoadRefusesAMissingCrossTenantURL(t *testing.T) {
	t.Setenv("DATABASE_CROSS_TENANT_URL", "")
	t.Setenv("RABBITMQ_URL", someBroker)

	_, err := Load()

	if err == nil {
		t.Fatal("Load() = nil error, want a refusal")
	}
	if !strings.Contains(err.Error(), "DATABASE_CROSS_TENANT_URL") {
		t.Errorf("refusal %q does not name the variable", err)
	}
}

func TestLoadDefaultsAreUsableWithoutAnyTuning(t *testing.T) {
	t.Setenv("DATABASE_CROSS_TENANT_URL", someDSN)
	t.Setenv("RABBITMQ_URL", someBroker)

	cfg, err := Load()

	if err != nil {
		t.Fatalf("Load() = %v, want nil", err)
	}
	if cfg.Port != "8090" {
		t.Errorf("Port = %q, want the default 8090", cfg.Port)
	}
	if cfg.PoolMinConns > cfg.PoolMaxConns {
		t.Errorf("default pool is inverted: min %d > max %d", cfg.PoolMinConns, cfg.PoolMaxConns)
	}
	if cfg.BootAssertTimeout <= 0 {
		t.Error("BootAssertTimeout must be positive or the boot assertion cannot finish")
	}
	if cfg.BrokerExchange != publish.DefaultExchange {
		t.Errorf("BrokerExchange = %q, want the declared default %q", cfg.BrokerExchange, publish.DefaultExchange)
	}
}

// A collector that cannot publish cannot move a cursor, so every pass it read
// would be read again for ever. It refuses to start instead (F-027-m).
func TestLoadRefusesAMissingBrokerURL(t *testing.T) {
	t.Setenv("DATABASE_CROSS_TENANT_URL", someDSN)
	t.Setenv("RABBITMQ_URL", "")

	_, err := Load()

	if err == nil {
		t.Fatal("Load() = nil error, want a refusal")
	}
	if !strings.Contains(err.Error(), "RABBITMQ_URL") {
		t.Errorf("refusal %q does not name the variable", err)
	}
}

func TestLoadReadsOverrides(t *testing.T) {
	t.Setenv("DATABASE_CROSS_TENANT_URL", someDSN)
	t.Setenv("RABBITMQ_URL", someBroker)
	t.Setenv("NETWORK_SERVICE_PORT", "9999")
	t.Setenv("NETWORK_DB_POOL_MAX_CONNS", "40")
	t.Setenv("NETWORK_DB_CONNECT_TIMEOUT", "3s")

	cfg, err := Load()

	if err != nil {
		t.Fatalf("Load() = %v, want nil", err)
	}
	if cfg.Port != "9999" || cfg.PoolMaxConns != 40 || cfg.ConnectTimeout != 3*time.Second {
		t.Errorf("overrides not read: %+v", cfg)
	}
}

func TestLoadRefusesAnInvertedPool(t *testing.T) {
	t.Setenv("DATABASE_CROSS_TENANT_URL", someDSN)
	t.Setenv("RABBITMQ_URL", someBroker)
	t.Setenv("NETWORK_DB_POOL_MAX_CONNS", "2")
	t.Setenv("NETWORK_DB_POOL_MIN_CONNS", "8")

	if _, err := Load(); err == nil {
		t.Fatal("Load() = nil error, want a refusal")
	}
}
