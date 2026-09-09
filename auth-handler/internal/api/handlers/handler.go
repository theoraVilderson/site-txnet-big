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
			return response.Err(keyAuthRequired, nil), nil
		}

		claims, err := jwt.Validate(token, h.secret)
		if err != nil {
			h.logger.Warn("token validation failed", "error", err)
			return response.Err(keyInvalidToken, nil), nil
		}

		active, err := h.redis.SessionActive(h.keyPrefix + "session:" + claims.SessionID)
		if err != nil {
			h.logger.Error("session lookup failed", "error", err, "session_id", claims.SessionID)
			return response.Err(keyUnexpected, nil), nil
		}
		if !active {
			return response.Err(keySessionRevoked, nil), nil
		}

		if h.engine != nil {
			if unauthorized, ok := h.engine.Check(claims.RoleID, claims.Permissions); !ok {
				h.logger.Warn("token claims unauthorized permissions",
					"role", claims.RoleID, "user_id", claims.Sub, "unauthorized", unauthorized)
				return response.Err(keyForbidden, nil), nil
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
		return response.Ok(nil, keySuccess), nil
	}, keySuccess, keyUnexpected)

	// Map the outcome to an HTTP status BEFORE translation rewrites result.Msg.
	// Traefik ForwardAuth only forwards the request upstream on a 2xx; any
	// other status blocks it and is returned to the client as-is.
	status := statusForKey(result.OK, result.Msg)

	// Translate the message using the request's language. Only a failure is
	// translated: a 2xx never reaches a person — Traefik forwards the request
	// upstream and throws this body away — while `msg` on a failure is shown
	// as-is by whoever asked (`panel-web`, the bot).
	if !result.OK {
		result.Msg = middlewares.Translate(r, middlewares.ErrorsNamespace, result.Msg)
	}

	writeJSON(w, result, status)
}

// The keys this gateway answers with. They name entries in the shared `errors`
// namespace (`locales/backend/langs/*/errors.json`) — the same catalogue
// `auth-service` translates against — because a caller shows `msg` to a person
// and a gateway of its own invented vocabulary has nothing to translate with.
const (
	keyAuthRequired   = "auth.authorizationRequired"
	keyInvalidToken   = "auth.invalidToken"
	keySessionRevoked = "auth.sessionRevoked"
	keyForbidden      = "permissions.forbidden"
	keyUnexpected     = "system.unexpected"
	// Never shown: a 2xx body is consumed by Traefik, not by a person.
	keySuccess = "ok"
)

// statusForKey maps a response message key to an HTTP status code.
func statusForKey(ok bool, msgKey string) int {
	if ok {
		return http.StatusOK
	}
	switch msgKey {
	case keyForbidden:
		return http.StatusForbidden
	case keyUnexpected:
		return http.StatusInternalServerError
	default: // keyAuthRequired, keyInvalidToken, keySessionRevoked
		return http.StatusUnauthorized
	}
}

// Health is a simple health check endpoint.
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, response.Ok("healthy", keySuccess), http.StatusOK)
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
