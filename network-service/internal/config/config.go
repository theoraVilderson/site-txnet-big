// Package config loads and validates the environment this service runs under.
package config

import (
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"time"

	"network-service/internal/egress"
	"network-service/internal/publish"
)

// Config holds every runtime setting of the network plane's collector.
type Config struct {
	// Port serves the health endpoint only. Nothing here answers a user
	// request: this service connects as the cross-tenant role, so it is
	// deliberately not reachable from the gateway (ADR-0071).
	Port string
	// DatabaseURL is the cross-tenant connection — the same
	// `DATABASE_CROSS_TENANT_URL` the Nest services read, so one secret
	// describes one role in one place.
	DatabaseURL       string
	PoolMaxConns      int
	PoolMinConns      int
	PoolMaxConnLife   time.Duration
	PoolMaxConnIdle   time.Duration
	ConnectTimeout    time.Duration
	BootAssertTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	ShutdownTimeout   time.Duration
	// BrokerURL and BrokerExchange are where a collection pass goes
	// (F-027-m). They are the same `RABBITMQ_URL` and `AUTOMATION_EXCHANGE`
	// every Nest publisher reads, because it is one broker and one exchange —
	// the routing key is what separates this traffic, not a second topology.
	BrokerURL            string
	BrokerExchange       string
	BrokerPublishTimeout time.Duration

	// TenantAPIBaseURL and ServiceAuthToken are how a panel's login is read:
	// tenant-service's service-only vault route (F-027-aw). Without them every
	// pending panel would be tested as unopenable, so both refuse the boot.
	TenantAPIBaseURL string
	ServiceAuthToken string

	// RadiusAddr is the UDP address the RADIUS accounting receiver listens
	// on (F-027-af). It is the one surface of this service reachable from
	// outside, which is why it answers only an accepted push panel's address
	// under that panel's own secret (ADR-0071).
	RadiusAddr        string
	RadiusStaleAfter  time.Duration
	RadiusRefresh     time.Duration
	RadiusConcurrency int

	// PanelEgressAllow opens private ranges a panel may be dialed at — the
	// operator's own routers behind the platform VPN. Empty by default: every
	// private, loopback, link-local and metadata address is refused (F-027-dl).
	PanelEgressAllow []netip.Prefix
}

// Load reads configuration from the environment and validates it.
func Load() (Config, error) {
	cfg := Config{
		Port:                 getEnv("NETWORK_SERVICE_PORT", "8090"),
		DatabaseURL:          os.Getenv("DATABASE_CROSS_TENANT_URL"),
		PoolMaxConns:         getEnvInt("NETWORK_DB_POOL_MAX_CONNS", 10),
		PoolMinConns:         getEnvInt("NETWORK_DB_POOL_MIN_CONNS", 2),
		PoolMaxConnLife:      getEnvDuration("NETWORK_DB_POOL_MAX_CONN_LIFETIME", time.Hour),
		PoolMaxConnIdle:      getEnvDuration("NETWORK_DB_POOL_MAX_CONN_IDLE", 30*time.Minute),
		ConnectTimeout:       getEnvDuration("NETWORK_DB_CONNECT_TIMEOUT", 5*time.Second),
		BootAssertTimeout:    getEnvDuration("NETWORK_DB_BOOT_ASSERT_TIMEOUT", 10*time.Second),
		ReadTimeout:          getEnvDuration("HTTP_READ_TIMEOUT", 5*time.Second),
		WriteTimeout:         getEnvDuration("HTTP_WRITE_TIMEOUT", 5*time.Second),
		IdleTimeout:          getEnvDuration("HTTP_IDLE_TIMEOUT", 60*time.Second),
		ShutdownTimeout:      getEnvDuration("HTTP_SHUTDOWN_TIMEOUT", 10*time.Second),
		BrokerURL:            os.Getenv("RABBITMQ_URL"),
		BrokerExchange:       getEnv("AUTOMATION_EXCHANGE", publish.DefaultExchange),
		BrokerPublishTimeout: getEnvDuration("NETWORK_BROKER_PUBLISH_TIMEOUT", publish.DefaultConfirmTimeout),
		TenantAPIBaseURL:     os.Getenv("TENANT_API_BASE_URL"),
		ServiceAuthToken:     os.Getenv("SERVICE_AUTH_TOKEN"),
		RadiusAddr:           getEnv("RADIUS_ACCT_ADDR", ":1813"),
		RadiusStaleAfter:     getEnvDuration("RADIUS_STALE_AFTER", time.Hour),
		RadiusRefresh:        getEnvDuration("RADIUS_ALLOWLIST_REFRESH", time.Minute),
		RadiusConcurrency:    getEnvInt("RADIUS_CONCURRENCY", 32),
	}
	allow, err := egress.ParseAllow(os.Getenv("PANEL_EGRESS_ALLOW_CIDRS"))
	if err != nil {
		return Config{}, err
	}
	cfg.PanelEgressAllow = allow
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// validate refuses a configuration this service cannot run honestly under.
// There is no fallback to an owner connection on purpose: a missing
// cross-tenant URL must stop the process, not quietly widen its privileges.
func (c Config) validate() error {
	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_CROSS_TENANT_URL is required")
	}
	// A collector that cannot publish cannot move a cursor, so it cannot
	// collect: every pass it read would be re-read for ever. That is a
	// refusal to start, not a degraded mode (F-027-m).
	if c.BrokerURL == "" {
		return fmt.Errorf("RABBITMQ_URL is required")
	}
	if c.TenantAPIBaseURL == "" {
		return fmt.Errorf("TENANT_API_BASE_URL is required: a panel's login is read through tenant-service")
	}
	if c.ServiceAuthToken == "" {
		return fmt.Errorf("SERVICE_AUTH_TOKEN is required: tenant-service's vault route answers nothing without it")
	}
	if c.Port == "" {
		return fmt.Errorf("NETWORK_SERVICE_PORT must not be empty")
	}
	if c.RadiusConcurrency < 1 {
		return fmt.Errorf("RADIUS_CONCURRENCY must be at least 1, got %d", c.RadiusConcurrency)
	}
	if c.RadiusStaleAfter <= 0 {
		return fmt.Errorf("RADIUS_STALE_AFTER must be positive, got %s", c.RadiusStaleAfter)
	}
	if c.PoolMaxConns < 1 {
		return fmt.Errorf("NETWORK_DB_POOL_MAX_CONNS must be at least 1, got %d", c.PoolMaxConns)
	}
	if c.PoolMinConns < 0 {
		return fmt.Errorf("NETWORK_DB_POOL_MIN_CONNS must not be negative, got %d", c.PoolMinConns)
	}
	if c.PoolMinConns > c.PoolMaxConns {
		return fmt.Errorf(
			"NETWORK_DB_POOL_MIN_CONNS (%d) exceeds NETWORK_DB_POOL_MAX_CONNS (%d)",
			c.PoolMinConns, c.PoolMaxConns)
	}
	return nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}
