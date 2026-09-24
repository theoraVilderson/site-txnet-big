// Package config loads and validates the environment this service runs under.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds every runtime setting of `sub-service`.
type Config struct {
	// Port serves `/sub/{token}` (through the gateway) and `/health` (for the
	// container only).
	Port string
	// DatabaseURL is the cross-tenant connection, the same
	// `DATABASE_CROSS_TENANT_URL` every other service reads. The pool makes
	// it read-only (internal/db).
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
}

// Load reads configuration from the environment and validates it.
func Load() (Config, error) {
	cfg := Config{
		Port:              getEnv("SUB_SERVICE_PORT", "8091"),
		DatabaseURL:       os.Getenv("DATABASE_CROSS_TENANT_URL"),
		PoolMaxConns:      getEnvInt("SUB_DB_POOL_MAX_CONNS", 20),
		PoolMinConns:      getEnvInt("SUB_DB_POOL_MIN_CONNS", 2),
		PoolMaxConnLife:   getEnvDuration("SUB_DB_POOL_MAX_CONN_LIFETIME", time.Hour),
		PoolMaxConnIdle:   getEnvDuration("SUB_DB_POOL_MAX_CONN_IDLE", 30*time.Minute),
		ConnectTimeout:    getEnvDuration("SUB_DB_CONNECT_TIMEOUT", 5*time.Second),
		BootAssertTimeout: getEnvDuration("SUB_DB_BOOT_ASSERT_TIMEOUT", 10*time.Second),
		ReadTimeout:       getEnvDuration("HTTP_READ_TIMEOUT", 5*time.Second),
		WriteTimeout:      getEnvDuration("HTTP_WRITE_TIMEOUT", 5*time.Second),
		IdleTimeout:       getEnvDuration("HTTP_IDLE_TIMEOUT", 60*time.Second),
		ShutdownTimeout:   getEnvDuration("HTTP_SHUTDOWN_TIMEOUT", 10*time.Second),
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) validate() error {
	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_CROSS_TENANT_URL is required")
	}
	if c.Port == "" {
		return fmt.Errorf("SUB_SERVICE_PORT must not be empty")
	}
	if c.PoolMaxConns < 1 {
		return fmt.Errorf("SUB_DB_POOL_MAX_CONNS must be at least 1, got %d", c.PoolMaxConns)
	}
	if c.PoolMinConns < 0 || c.PoolMinConns > c.PoolMaxConns {
		return fmt.Errorf("SUB_DB_POOL_MIN_CONNS (%d) must be between 0 and SUB_DB_POOL_MAX_CONNS (%d)",
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
