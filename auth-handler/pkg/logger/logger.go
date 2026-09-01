// Package logger provides a structured JSON logger based on slog.
package logger

import (
	"log/slog"
	"os"
)

// New creates a new slog.Logger with JSON handler.
// Level can be "debug", "info" (default), "warn", or "error".
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
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})
	return slog.New(handler)
}
