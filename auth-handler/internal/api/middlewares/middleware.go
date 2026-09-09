// Package middlewares provides HTTP middleware functions for the gateway.
package middlewares

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"auth-handler/internal/locale"
	"auth-handler/internal/response"
)

// Chain applies middlewares in order. Chain(h, A, B) means "A wraps B wraps h".
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// RequestLogger logs method, path, status, duration, and remote address.
func RequestLogger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(sw, r)
			log.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", sw.status,
				"duration_ms", time.Since(start).Milliseconds(),
				"remote_addr", r.RemoteAddr,
			)
		})
	}
}

// ErrorsNamespace is where every message this gateway sends a client lives:
// the shared backend catalogue, so a key here is one `auth-service` also knows.
const ErrorsNamespace = "errors"

// Recoverer converts a panic into a 500 carrying the standard envelope.
//
// It sits INSIDE LanguageMiddleware (see cmd/server/main.go) so the sentence it
// writes is in the caller's language; the cost is that a panic in
// LanguageMiddleware itself is not caught, which is three lines of map lookup.
func Recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if err := recover(); err != nil {
					// The panic value stays in the log: it is a stack detail.
					log.Error("panic recovered", "error", err, "path", r.URL.Path)
					WriteError(w, r, "system.unexpected", http.StatusInternalServerError)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// Timeout cancels a request after a given duration.
//
// The handler is built per request rather than once per wrap: its timeout body
// is fixed at construction, and a fixed body cannot be in the caller's
// language. Everything hard about a timeout — buffering the handler's writes,
// and the race between them and the deadline — stays in the stdlib.
func Timeout(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body := errorEnvelope(Translate(r, ErrorsNamespace, "system.unavailable"))
			http.TimeoutHandler(next, d, body).ServeHTTP(w, r)
		})
	}
}

// WriteError sends the standard envelope with `msgKey` translated into the
// request's language. Every answer this gateway gives a client has the shape a
// caller already handles — `{ok, msg}` — including the ones no handler wrote.
func WriteError(w http.ResponseWriter, r *http.Request, msgKey string, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, errorEnvelope(Translate(r, ErrorsNamespace, msgKey)))
}

func errorEnvelope(msg string) string {
	encoded, err := json.Marshal(response.Response{OK: false, Msg: msg})
	if err != nil {
		// Response holds a bool and a string; this cannot fail, and a caller
		// that got an empty body would still see the status.
		return `{"ok":false,"msg":""}`
	}
	return string(encoded)
}

// statusWriter captures the HTTP status code for logging.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(status int) {
	sw.status = status
	sw.ResponseWriter.WriteHeader(status)
}

// LanguageMiddleware sets the resolved language and locale store in the request context.
func LanguageMiddleware(store *locale.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			lang := store.ResolveLanguage(r.Header.Get("Accept-Language"))

			ctx := context.WithValue(r.Context(), languageContextKey, lang)
			ctx = context.WithValue(ctx, localeStoreKey, store)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

type contextKey string

const (
	languageContextKey contextKey = "language"
	localeStoreKey     contextKey = "localeStore"
)

// Translate returns the translation for the given namespace and key using the request's language.
// If no translation found, returns the key itself.
func Translate(r *http.Request, namespace, key string) string {
	store, ok := r.Context().Value(localeStoreKey).(*locale.Store)
	if !ok {
		return key
	}
	lang, _ := r.Context().Value(languageContextKey).(string)
	return store.Translate(lang, namespace, key)
}
