// Package config loads and validates environment variables required by the gateway.
package config

import (
	"auth-handler/internal/locale"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all runtime settings for the gateway.
type Config struct {
	Port              string
	JWTSecret         string
	RedisURL          string
	RedisKeyPrefix    string
	PermissionsFile   string
	LocalesDir        string
	LocalesWatch      bool
	DefaultLanguage   string
	LocaleServiceAddr string
	LocaleScope       string
	LocaleBootTimeout time.Duration
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	ShutdownTimeout   time.Duration
	RedisDialTimeout  time.Duration
	RedisReadTimeout  time.Duration
	RedisPoolSize     int
}

// Load reads configuration from environment and validates required fields.
func Load() (Config, error) {
	cfg := Config{
		Port:      getEnv("GATEWAY_PORT", "8080"),
		JWTSecret: firstNonEmpty(os.Getenv("JWT_SECRET"), os.Getenv("JWT_ACCESS_SECRET")),
		RedisURL:  os.Getenv("REDIS_URL"),
		// Must match auth-service's RedisService.keyPrefix
		// (`${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`) so this gateway
		// reads the same `session:*` keys the auth-service writes.
		RedisKeyPrefix: buildRedisKeyPrefix(
			getEnv("REDIS_KEY_NAMESPACE", DefaultRedisKeyNamespace),
			getEnv("REDIS_KEYSPACE_VERSION", DefaultRedisKeyspaceVersion),
		),
		PermissionsFile:   getEnv("PERMISSIONS_FILE_PATH", "configs/permissions.yaml"),
		LocalesDir:        getEnv("LOCALES_DIR", "./locales/langs"),
		LocalesWatch:      getEnv("LOCALES_WATCH", "false") == "true",
		DefaultLanguage:   getEnv("DEFAULT_LANGUAGE", "fa"),
		LocaleServiceAddr: getEnv("LOCALE_SERVICE_ADDR", "localhost:50051"),
		LocaleScope:       getEnv("LOCALE_SCOPE", "backend"),
		// Read like every other timeout in this struct rather than hardcoded
		// in two packages at two different values (F-086).
		LocaleBootTimeout: getEnvDuration("LOCALE_BOOT_TIMEOUT", locale.DefaultBootTimeout),
		ReadTimeout:       getEnvDuration("HTTP_READ_TIMEOUT", 5*time.Second),
		WriteTimeout:      getEnvDuration("HTTP_WRITE_TIMEOUT", 5*time.Second),
		IdleTimeout:       getEnvDuration("HTTP_IDLE_TIMEOUT", 60*time.Second),
		ShutdownTimeout:   getEnvDuration("HTTP_SHUTDOWN_TIMEOUT", 10*time.Second),
		RedisDialTimeout:  getEnvDuration("REDIS_DIAL_TIMEOUT", 2*time.Second),
		RedisReadTimeout:  getEnvDuration("REDIS_READ_TIMEOUT", 2*time.Second),
		RedisPoolSize:     getEnvInt("REDIS_POOL_SIZE", 10),
	}

	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// validate ensures mandatory configuration values are present.
func (c Config) validate() error {
	var missing []string
	if c.JWTSecret == "" {
		missing = append(missing, "JWT_SECRET (or JWT_ACCESS_SECRET)")
	}
	if c.RedisURL == "" {
		missing = append(missing, "REDIS_URL")
	}
	if len(missing) > 0 {
		return fmt.Errorf("config: missing required environment variable(s): %v", missing)
	}
	return nil
}

// Helper functions.

// The keyspace defaults, declared in contracts/redis/keyspace.json and held to
// it by keyspace_contract_test.go (ADR-0036, C-03).
//
// They were `txnet:auth` and `v1` here, `v2` in `.env` and `v3` in
// docker-compose, so which keyspace a container read depended on whether
// `.env` reached it. The fleet was genuinely split — 8 live sessions under
// `v1` and 7 under `v2` when F-075 measured it — and a user whose session was
// in the half a given service could not see was signed out by that service
// and signed in by the next one. Unified on `v2`, the value `.env` already
// carried, so the sessions living in dev survived.
//
// Changing the version is a forced logout of everybody. That is what it is
// for, and it means every service and this gateway deploy together: a rolling
// deploy across a version change is a partial outage by construction.
const (
	DefaultRedisKeyNamespace    = "txnet:auth"
	DefaultRedisKeyspaceVersion = "v2"
)

// buildRedisKeyPrefix is the one prefix algorithm, shared with
// shared-core/src/lib/redis/keyspace.ts through contracts/redis/keyspace.json.
//
// The TrimRight is not defensive tidying: a trailing colon in
// REDIS_KEY_NAMESPACE that only one language strips puts Go and Node in
// different keyspaces, which reads as every session being revoked.
func buildRedisKeyPrefix(namespace, version string) string {
	return strings.TrimRight(namespace, ":") + ":" + version + ":"
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
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
