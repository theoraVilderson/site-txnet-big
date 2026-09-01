// main.go is the entry point for the authorization handler.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"auth-handler/internal/api/handlers"
	"auth-handler/internal/api/middlewares"
	"auth-handler/internal/auth"
	"auth-handler/internal/cache"
	"auth-handler/internal/config"
	"auth-handler/internal/locale"
	"auth-handler/pkg/logger"
)

func main() {
	// Load configuration.
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(1)
	}

	// Initialize logger.
	log := logger.New(os.Getenv("LOG_LEVEL"))

	// Initialize Redis client.
	redisClient, err := cache.New(cfg.RedisURL, cfg.RedisPoolSize, cfg.RedisDialTimeout, cfg.RedisReadTimeout)
	if err != nil {
		log.Error("failed to init redis client", "error", err)
		os.Exit(1)
	}
	defer redisClient.Close()

	// Load policy engine (optional).
	engine, err := auth.LoadFile(cfg.PermissionsFile)
	if err != nil {
		log.Warn("policy engine disabled: could not load permissions file", "error", err, "path", cfg.PermissionsFile)
		engine = nil
	}

	// Connect to locale-service (source of truth) and block until the initial
	// snapshots are cached, then keep them live over the Watch stream.
	localeStore := locale.NewStore(cfg.LocaleServiceAddr, cfg.LocaleScope, cfg.DefaultLanguage, log)
	if err := localeStore.Load(); err != nil {
		log.Error("initial locale load failed", "error", err, "addr", cfg.LocaleServiceAddr)
		os.Exit(1)
	}
	defer localeStore.Close()
	if err := localeStore.StartWatching(cfg.LocalesWatch); err != nil {
		log.Error("locale watcher failed", "error", err)
		os.Exit(1)
	}

	// Create handler.
	h := handlers.New(redisClient, cfg.JWTSecret, cfg.RedisKeyPrefix, engine, log)

	// Set up HTTP routes.
	mux := http.NewServeMux()
	mux.HandleFunc("/validate", h.Validate)
	mux.HandleFunc("/health", h.Health)

	// Apply middleware chain.
	wrapped := middlewares.Chain(mux,
		middlewares.Recoverer(log),
		middlewares.RequestLogger(log),
		middlewares.LanguageMiddleware(localeStore),
		middlewares.Timeout(5*time.Second),
	)

	// Create HTTP server with timeouts.
	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      wrapped,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}

	// Start server in goroutine.
	go func() {
		log.Info("authorization-handler listening", "port", cfg.Port, "session_keyspace", cfg.RedisKeyPrefix)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("graceful shutdown failed", "error", err)
	}
}
