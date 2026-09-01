// Package handlers contains the HTTP handlers for the authorization gateway.
package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"auth-handler/internal/api/middlewares"
	"auth-handler/internal/auth"
	"auth-handler/internal/cache"
	"auth-handler/internal/jwt"
	"auth-handler/internal/response"
)

// Handler holds dependencies for request validation.
type Handler struct {
	redis     *cache.Client
	secret    string
	keyPrefix string       // Redis keyspace prefix, shared with auth-service
	engine    *auth.Engine // nil means policy enforcement is disabled
	logger    *slog.Logger
}

// New creates a new Handler instance.
func New(redis *cache.Client, jwtSecret, redisKeyPrefix string, engine *auth.Engine, logger *slog.Logger) *Handler {
	return &Handler{redis: redis, secret: jwtSecret, keyPrefix: redisKeyPrefix, engine: engine, logger: logger}
}

// Validate is the main authentication endpoint.
// It validates the JWT, checks the session in Redis, enforces RBAC policy,
// and returns identity headers on success. Error messages are localized.
func (h *Handler) Validate(w http.ResponseWriter, r *http.Request) {
	result := response.SafeExecute(r.Context(), func() (interface{}, error) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" {
			return response.Err("missing_bearer_token", nil), nil
		}

		claims, err := jwt.Validate(token, h.secret)
		if err != nil {
			h.logger.Warn("token validation failed", "error", err)
			return response.Err("unauthorized", nil), nil
		}

		active, err := h.redis.SessionActive(h.keyPrefix + "session:" + claims.SessionID)
		if err != nil {
			h.logger.Error("session lookup failed", "error", err, "session_id", claims.SessionID)
			return response.Err("internal_error", nil), nil
		}
		if !active {
			return response.Err("session_revoked", nil), nil
		}

		if h.engine != nil {
			if unauthorized, ok := h.engine.Check(claims.RoleID, claims.Permissions); !ok {
				h.logger.Warn("token claims unauthorized permissions",
					"role", claims.RoleID, "user_id", claims.Sub, "unauthorized", unauthorized)
				return response.Err("forbidden", nil), nil
			}
		}

		// Success: set identity headers.
		w.Header().Set("X-User-Id", claims.Sub)
		w.Header().Set("X-Tenant-Id", claims.TenantID)
		w.Header().Set("X-Role-Id", claims.RoleID)
		w.Header().Set("X-User-Permissions", strings.Join(claims.Permissions, ","))
		if claims.IsImpersonated {
			w.Header().Set("X-Impersonated", "true")
			w.Header().Set("X-Impersonated-By", claims.ImpersonatedBy)
		}
		return response.Ok(nil, "successful"), nil
	}, "successful", "failed")

	// Map the outcome to an HTTP status BEFORE translation rewrites result.Msg.
	// Traefik ForwardAuth only forwards the request upstream on a 2xx; any
	// other status blocks it and is returned to the client as-is.
	status := statusForKey(result.OK, result.Msg)

	// Translate the message using the request's language.
	result.Msg = middlewares.Translate(r, "messages", result.Msg)

	writeJSON(w, result, status)
}

// statusForKey maps an internal response message key to an HTTP status code.
func statusForKey(ok bool, msgKey string) int {
	if ok {
		return http.StatusOK
	}
	switch msgKey {
	case "forbidden":
		return http.StatusForbidden
	case "internal_error", "failed":
		return http.StatusInternalServerError
	default: // missing_bearer_token, unauthorized, session_revoked
		return http.StatusUnauthorized
	}
}

// Health is a simple health check endpoint.
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, response.Ok("healthy", "healthy"), http.StatusOK)
}

// writeJSON writes a standardized JSON response.
func writeJSON(w http.ResponseWriter, resp response.Response, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		// If encoding fails, we can't do much; log it.
		// (we could use a logger here, but to avoid import cycles we just ignore)
	}
}
