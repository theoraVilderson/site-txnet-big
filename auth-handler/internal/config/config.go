// Package config loads and validates environment variables required by the gateway.
package config

import (
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
			getEnv("REDIS_KEY_NAMESPACE", "txnet:auth"),
			getEnv("REDIS_KEYSPACE_VERSION", "v1"),
		),
		PermissionsFile:   getEnv("PERMISSIONS_FILE_PATH", "configs/permissions.yaml"),
		LocalesDir:        getEnv("LOCALES_DIR", "./locales/langs"),
		LocalesWatch:      getEnv("LOCALES_WATCH", "false") == "true",
		DefaultLanguage:   getEnv("DEFAULT_LANGUAGE", "fa"),
		LocaleServiceAddr: getEnv("LOCALE_SERVICE_ADDR", "localhost:50051"),
		LocaleScope:       getEnv("LOCALE_SCOPE", "backend"),
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

// buildRedisKeyPrefix mirrors auth-service's RedisService: the namespace with
// any trailing ':' stripped, then ":<version>:". Keep this in sync with
// txnet-backend/auth-service/src/app/redis/redis.service.ts.
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
