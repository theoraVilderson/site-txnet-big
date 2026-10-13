// Package logger provides a structured JSON logger based on slog.
package logger

import (
	"context"
	"io"
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
	return newLogger(os.Stdout, lvl)
}

func newLogger(w io.Writer, lvl slog.Level) *slog.Logger {
	return slog.New(requestIDHandler{slog.NewJSONHandler(w, &slog.HandlerOptions{Level: lvl})})
}

type requestIDKey struct{}

// WithRequestID returns ctx carrying the request id (H13, hosting/contract.md)
// that every line logged with it names.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

// RequestID is the id WithRequestID put on ctx, or "" outside a request.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// requestIDHandler adds `requestId` — the Node services' key (H12) — to a line
// logged with a request's context, so one Loki query reads the gate and the
// services behind it. Only the *Context logging calls carry a context.
type requestIDHandler struct{ slog.Handler }

func (h requestIDHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestID(ctx); id != "" {
		r.AddAttrs(slog.String("requestId", id))
	}
	return h.Handler.Handle(ctx, r)
}

func (h requestIDHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return requestIDHandler{h.Handler.WithAttrs(attrs)}
}

func (h requestIDHandler) WithGroup(name string) slog.Handler {
	return requestIDHandler{h.Handler.WithGroup(name)}
}
