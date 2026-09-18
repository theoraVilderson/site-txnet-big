// Package handlers contains the HTTP handlers for the authorization gateway.
package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"auth-handler/internal/api/middlewares"
	"auth-handler/internal/auth"
	"auth-handler/internal/cache"
	"auth-handler/internal/i18nkeys"
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
	// origins a refusal may be read from (CORS_ALLOWED_ORIGINS); empty adds no CORS headers.
	corsOrigins map[string]struct{}
}

// New creates a new Handler instance.
func New(redis *cache.Client, jwtSecret, redisKeyPrefix string, engine *auth.Engine, logger *slog.Logger) *Handler {
	return &Handler{redis: redis, secret: jwtSecret, keyPrefix: redisKeyPrefix, engine: engine, logger: logger}
}

// WithCORSOrigins names the browser origins allowed to read a refusal.
//
// Traefik returns a ForwardAuth refusal to the client as it is, so the upstream
// service's own CORS never runs on it. Without these headers the browser hides
// a 401 behind a CORS error, and the panel cannot tell an expired token from an
// unreachable server — so it never refreshes. Only refusals get them: a 2xx is
// discarded by Traefik, and the service answers CORS for itself.
func (h *Handler) WithCORSOrigins(origins []string) *Handler {
	h.corsOrigins = make(map[string]struct{}, len(origins))
	for _, o := range origins {
		if o = strings.TrimSpace(o); o != "" {
			h.corsOrigins[o] = struct{}{}
		}
	}
	return h
}

// Validate is the main authentication endpoint.
// It validates the JWT, checks the session in Redis, enforces RBAC policy,
// and returns identity headers on success. Error messages are localized.
//
// A credential is required here. The router that admits a caller without one
// is ValidateOptional, below.
func (h *Handler) Validate(w http.ResponseWriter, r *http.Request) {
	h.finish(w, r, h.decide(w, r))
}

// decide runs the access decision and, on success only, writes the identity
// headers onto w. Split out of Validate so the optional gate can reuse the
// whole of it rather than a paraphrase of it — two copies of an authorization
// decision is exactly the second identity model ADR-0030 exists to avoid, and
// it would be no better for being in the same file.
func (h *Handler) decide(w http.ResponseWriter, r *http.Request) response.Response {
	return response.SafeExecute(r.Context(), func() (interface{}, error) {
		token := tokenFrom(r)
		if token == "" {
			// Most often a page that called before its session was established;
			// the panel turns its refresh cookie into a token and sends again.
			return response.Err(keyAuthRequired, map[string]string{"reason": reasonAuthorizationRequired}), nil
		}

		claims, err := jwt.Validate(token, h.secret)
		if err != nil {
			// Only a token this gate issued and time alone retired is "expired":
			// the signature checked out and it names a session. Anything else
			// stays invalid, with no reason a client would refresh on.
			if errors.Is(err, jwt.ErrExpired) && claims.Sub != "" && claims.SessionID != "" {
				return response.Err(keyTokenExpired, map[string]string{"reason": reasonTokenExpired}), nil
			}
			h.logger.Warn("token validation failed", "error", err)
			return response.Err(keyInvalidToken, nil), nil
		}

		// One round trip for the three things a decision reads: whether the
		// session lives, what the token's role grants now, and which role the
		// user holds now (ADR-0043).
		values, err := h.redis.GetMany(
			cache.SessionKey(h.keyPrefix, claims.SessionID),
			cache.RolePermissionsKey(h.keyPrefix, claims.RoleID),
			cache.UserRoleKey(h.keyPrefix, claims.Sub),
		)
		if err != nil {
			h.logger.Error("session lookup failed", "error", err, "session_id", claims.SessionID)
			return response.Err(keyUnexpected, nil), nil
		}
		if values[0] == "" {
			// Also what a rotated session looks like: every refresh revokes the
			// one it replaces, so another tab's refresh retires this token. The
			// client tries its refresh cookie once; a real sign-out fails there.
			return response.Err(keySessionRevoked, map[string]string{"reason": reasonSessionRevoked}), nil
		}
		if stalePermissions(claims, values[1], values[2]) {
			h.logger.Info("token permissions are stale",
				"user_id", claims.Sub, "role_id", claims.RoleID)
			return response.Err(keyPermissionsChanged, map[string]string{
				"reason": reasonPermissionsChanged,
			}), nil
		}

		if h.engine != nil {
			if unauthorized, ok := h.engine.Check(claims.RoleName, claims.Permissions); !ok {
				h.logger.Warn("token claims unauthorized permissions",
					"role", claims.RoleName, "role_id", claims.RoleID, "user_id", claims.Sub, "unauthorized", unauthorized)
				return response.Err(keyForbidden, nil), nil
			}
		}

		// Success: set identity headers.
		w.Header().Set(HeaderUserID, claims.Sub)
		w.Header().Set(HeaderTenantID, claims.TenantID)
		w.Header().Set(HeaderRoleID, claims.RoleID)
		// The session this token names, forwarded so a long-lived consumer can
		// re-ask the question this handler answered once (F-067-h).
		//
		// Every other identity header describes *who*; this one names the
		// grant, and it is here because a WebSocket outlives the access token
		// that opened it by hours. `gateway-service` re-checks
		// `session:<id>` on a timer and closes the socket when the marker is
		// gone, which is the same rule this handler applies per request —
		// missing marker means revoked, never "unknown, allow"
		// (`redis-keyspace/contract.md`). It cannot apply that rule to a
		// session nobody told it the id of.
		//
		// Traefik must both forward it (`authResponseHeaders`) and strip the
		// client-supplied copy (`strip-fake-headers`), exactly as for the
		// headers above: a header downstream trusts is a header a caller must
		// not be able to set.
		w.Header().Set(HeaderSessionID, claims.SessionID)
		w.Header().Set(HeaderUserPermissions, strings.Join(claims.Permissions, ","))
		if claims.IsImpersonated {
			w.Header().Set(HeaderImpersonated, "true")
			w.Header().Set(HeaderImpersonatedBy, claims.ImpersonatedBy)
		}
		if platform, chatID := chatOf(values[0]); platform != "" {
			w.Header().Set(HeaderChatPlatform, platform)
			w.Header().Set(HeaderChatUserID, chatID)
		}
		return response.Ok(nil, msgSuccess), nil
	}, msgSuccess, keyUnexpected)
}

// chatOf reads the messenger and the chat id out of a session value whose scope is a
// chat's (`{"scopeKey":"bot:<tenantId>:<platform>:<chatId>"}`, written by
// auth-service's SessionStore), or "" (F-104-q). A key minted before F-061-g
// has no tenant (`bot:<platform>:<chatId>`) and lives until its session's next
// refresh, so both shapes are read. The chat id is F-104-ab's payer id. The value is the one the decision already
// fetched, so the marker costs no round trip, and it is set by the server that
// verified the platform's signature — which is what makes it trustworthy where
// the panel's `?ma=` hint is not. Anything unreadable is simply no chat.
func chatOf(session string) (platform, chatID string) {
	var parsed struct {
		ScopeKey *string `json:"scopeKey"`
	}
	if json.Unmarshal([]byte(session), &parsed) != nil || parsed.ScopeKey == nil {
		return "", ""
	}
	parts := strings.Split(*parsed.ScopeKey, ":")
	if parts[0] != "bot" || (len(parts) != 3 && len(parts) != 4) || parts[len(parts)-1] == "" {
		return "", ""
	}
	for _, known := range ChatPlatforms {
		if parts[len(parts)-2] == known {
			return known, parts[len(parts)-1]
		}
	}
	return "", ""
}

// finish maps one decision onto the wire.
func (h *Handler) finish(w http.ResponseWriter, r *http.Request, result response.Response) {
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
		h.allowOrigin(w, r)
	}

	writeJSON(w, result, status)
}

// allowOrigin lets an allow-listed browser origin read this refusal. The origin
// is echoed, never `*`: the panel sends credentials, and `*` with credentials
// is refused by every browser.
func (h *Handler) allowOrigin(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	w.Header().Add("Vary", "Origin")
	if _, ok := h.corsOrigins[origin]; !ok {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
}

// ValidateOptional is the same decision as Validate for a caller that brought
// a credential, and a 200 identifying nobody for a caller that did not
// (ADR-0031).
//
// It exists for the realtime path. A WebSocket on this platform is the
// live-data transport, held open from the moment a page loads and long before
// anyone signs in — the OTP delivery result is pushed onto one during
// registration (F-067-j). Requiring a credential at the gate would make that
// upgrade impossible; not gating the path at all would move the check into
// `gateway-service`, which is the second identity model ADR-0030 rejected.
// This is the third answer: one gate, one decision, two outcomes.
//
// **Absent is anonymous; invalid is still 401.** A credential that was
// presented and did not check out is never downgraded to "nobody". Doing so
// would turn an expired token into a silent loss of privilege — a page that
// shows nothing instead of one that is told to sign in again — and it would
// let a caller reach an anonymous-but-admitted state by corrupting its own
// token, which is the one thing an optional gate must not offer.
func (h *Handler) ValidateOptional(w http.ResponseWriter, r *http.Request) {
	if !credentialOffered(r) {
		w.Header().Set(HeaderAnonymous, "true")
		h.finish(w, r, response.Ok(nil, msgSuccess))
		return
	}
	h.finish(w, r, h.decide(w, r))
}

// credentialOffered reports whether this request tried to authenticate at all.
//
// Deliberately broader than tokenFrom: it asks whether something credential-
// shaped arrived, not whether it was well formed. A `Sec-WebSocket-Protocol`
// list that carries more than the marker is an attempt, so a malformed one
// gets tokenFrom's "" and then the 401 that an empty token earns — rather
// than being quietly admitted as anonymous. The anchoring rule tokenFrom
// applies is about which entry may be believed; this is about whether the
// caller was trying, and the safe answer to that is yes whenever anything is
// there.
func credentialOffered(r *http.Request) bool {
	if strings.TrimSpace(r.Header.Get("Authorization")) != "" {
		return true
	}
	raw := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Protocol"))
	if raw == "" {
		return false
	}
	// The marker on its own is a browser opening a socket with no token: the
	// ordinary anonymous upgrade, not an attempt to authenticate.
	return len(strings.Split(raw, ",")) > 1
}

// realtimeSubprotocol marks a `Sec-WebSocket-Protocol` list as carrying an
// access token. It is the protocol `gateway-service` selects in the handshake
// response, and it must never be the token itself — a selected subprotocol is
// echoed back in a response header, and echoing the credential would put it
// somewhere the page never has to look.
//
// Versioned because it is on the wire: the day the frame format changes
// incompatibly the marker becomes `txnet.v2` and an old client is refused at
// the handshake instead of after it.
const realtimeSubprotocol = "txnet.v1"

// tokenFrom returns the access JWT a request carries, from either of the two
// places one can arrive.
//
// `Authorization: Bearer` is the form every caller uses and it wins whenever
// it is present. The second exists because a browser opening a WebSocket
// cannot set headers — `new WebSocket(url, protocols)` chooses exactly one
// thing about the upgrade request, the `Sec-WebSocket-Protocol` list, so that
// list is where the token has to ride (D-9, F-067-h). Traefik forwards the
// upgrade here like any other request, which is what lets one gate answer for
// both and is the reason this platform does not need a second identity model
// for realtime.
//
// The list is attacker-controlled, so it is matched exactly and never
// scanned: the marker must be the **first** entry and the token the second.
// Accepting the token from anywhere in the list would let a caller append a
// second credential after one the gateway already rejected, and searching for
// the marker rather than anchoring on it is how that becomes possible.
func tokenFrom(r *http.Request) string {
	if raw := r.Header.Get("Authorization"); raw != "" {
		return strings.TrimSpace(strings.TrimPrefix(raw, "Bearer "))
	}

	entries := strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",")
	if len(entries) != 2 || strings.TrimSpace(entries[0]) != realtimeSubprotocol {
		return ""
	}
	return strings.TrimSpace(entries[1])
}

// The keys this gateway answers with. They name entries in the shared `errors`
// namespace (`locales/backend/langs/*/errors.json`) — the same catalogue
// `auth-service` translates against — because a caller shows `msg` to a person
// and a gateway of its own invented vocabulary has nothing to translate with.
//
// Aliases of the generated constants, not literals (F-081, ADR-0036). These
// five were spelled here and again in `auth-service`'s `sanitize-error.ts`,
// with a comment as the only thing keeping the two in step. A key renamed in
// `errors.json` is now a build failure in both languages, not a raw key shown
// to a user of whichever side was missed.
const (
	keyAuthRequired       = i18nkeys.ErrorsAuthAuthorizationRequired
	keyInvalidToken       = i18nkeys.ErrorsAuthInvalidToken
	keyTokenExpired       = i18nkeys.ErrorsAuthTokenExpired
	keySessionRevoked     = i18nkeys.ErrorsAuthSessionRevoked
	keyPermissionsChanged = i18nkeys.ErrorsAuthPermissionsChanged
	keyForbidden          = i18nkeys.ErrorsPermissionsForbidden
	keyUnexpected         = i18nkeys.ErrorsSystemUnexpected
)

// msgSuccess is the `msg` of a 2xx. **It is not a translation key**, and was
// wrongly filed among them until F-081: `ok` is not in `errors.json`.
//
// That is safe for exactly one reason, now written down instead of implicit:
// finish() translates only failures. A 2xx from /validate is consumed by
// Traefik and thrown away, and /health is read by a probe — no person ever
// reads this string, so there is nothing to translate it into. If a success
// body ever reaches a person, this needs a real key — the `if !result.OK`
// guard in finish() is the whole invariant, and
// TestValidateSetsIdentityHeadersOnSuccess pins the body's `msg` to this
// string verbatim.
const msgSuccess = "ok"

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
	default: // keyAuthRequired, keyInvalidToken, keySessionRevoked, keyPermissionsChanged
		return http.StatusUnauthorized
	}
}

// Health is a simple health check endpoint.
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, response.Ok("healthy", msgSuccess), http.StatusOK)
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

// reasonPermissionsChanged is the machine-readable half of that refusal. `msg`
// is translated, so a client cannot match on it; `error.reason` is what tells
// a client to refresh once and retry instead of sending the user to sign in.
const reasonPermissionsChanged = "permissionsChanged"

// reasonTokenExpired tells a client the access token only aged out: refresh
// once from the cookie and retry, instead of sending the user to sign in.
const reasonTokenExpired = "tokenExpired"

// reasonSessionRevoked: the session marker is gone — signed out, or rotated by
// a refresh elsewhere. Only the refresh cookie can tell which.
const reasonSessionRevoked = "sessionRevoked"

// reasonAuthorizationRequired: no credential was sent at all.
const reasonAuthorizationRequired = "authorizationRequired"

// stalePermissions reports whether what the token says the caller may do is no
// longer true (ADR-0043): the user holds another role now, or the role's set
// has changed since the token was minted. An empty value means Redis knows
// nothing, and knowing nothing is never a reason to refuse — the session check
// above is the one that fails closed.
func stalePermissions(claims jwt.Claims, currentHash, currentRole string) bool {
	if currentRole != "" && currentRole != claims.RoleID {
		return true
	}
	return currentHash != "" && currentHash != claims.PermHash
}
