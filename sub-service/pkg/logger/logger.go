// Package logger provides a structured JSON logger based on slog, matching
// what `auth-handler` emits so one log pipeline reads both Go services.
package logger

import (
	"log/slog"
	"os"
)

// New creates a slog.Logger with a JSON handler.
// Level can be "debug", "info" (default), "warn" or "error".
func New(level string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}
