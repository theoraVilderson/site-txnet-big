// Package middlewares provides HTTP middleware functions for the gateway.
package middlewares

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"auth-handler/internal/locale"
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

// Recoverer converts a panic into a 500 response.
func Recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if err := recover(); err != nil {
					log.Error("panic recovered", "error", err, "path", r.URL.Path)
					http.Error(w, "internal server error", http.StatusInternalServerError)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// Timeout cancels a request after a given duration.
func Timeout(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.TimeoutHandler(next, d, `{"error":"request timeout"}`)
	}
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
