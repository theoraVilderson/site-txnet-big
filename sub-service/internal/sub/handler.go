// Package sub serves `GET /sub/{token}` (F-113, ADR-0082): one link per Grant,
// answered only on a subscription domain of the Grant's own tenant.
//
// It is the one surface of this service reachable from the edge, and it is
// read-only: the token in the path is the only authentication, no cookie is
// set or read and no CORS header is ever sent (catalog C-16). Rendering the
// Grant's stored link lines is F-113-b; until then a served Grant is an empty
// body, which every client app reads as a valid subscription with nothing in it.
package sub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
)

// Domain is a `tenant.tenant_domain` row, as much of it as decides whether a
// host may serve subscriptions.
type Domain struct {
	TenantID           string
	Purpose            string
	DomainType         string
	VerificationStatus string
}

// Grant is an `entitlement.grant` row, as much of it as this row reads.
type Grant struct {
	ID       string
	TenantID string
	Status   string
}

// Store is every read this endpoint makes. Neither method writes; the
// connection behind the Postgres one is read-only at the session level.
type Store interface {
	// DomainByHost finds the row whose `domainValue` is the normalised host.
	DomainByHost(ctx context.Context, host string) (Domain, bool, error)
	// GrantByTokenHash finds the Grant whose `subscriptionTokenHash` is the
	// lowercase hex SHA-256 of the path token.
	GrantByTokenHash(ctx context.Context, hash string) (Grant, bool, error)
}

// Handler serves the subscription endpoint.
type Handler struct {
	store Store
	log   *slog.Logger
}

// New builds the handler.
func New(store Store, log *slog.Logger) *Handler {
	return &Handler{store: store, log: log}
}

// Register mounts the route. The method is part of the pattern, so any other
// method — an `OPTIONS` preflight included — is refused by the mux with a 405
// and never reaches a lookup.
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /sub/{token}", h.Serve)
}

// servesSubscriptions is the routing rule for a host, the same one
// `tenant-resolver.service.ts` applies to resolve a tenant at all — a platform
// subdomain is proven by existing, a custom domain only once verified — plus
// the purpose: only a `subscription` domain answers `/sub` (F-066-q, C-16).
func servesSubscriptions(d Domain) bool {
	if d.Purpose != "subscription" {
		return false
	}
	return d.DomainType == "subdomain" || d.VerificationStatus == "verified"
}

// TokenHash is how a path token is stored: lowercase hex SHA-256. The token
// itself is never stored, logged or passed to the store.
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Serve answers one request.
//
// Every refusal is the same 404 with the same body, whichever check failed:
// a token that exists but belongs to another tenant must be indistinguishable
// from one that does not exist. A store failure is a 503, never a 404 — a
// client app that reads a 404 may drop the subscription, and a database outage
// is not the user's link being revoked.
func (h *Handler) Serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	token := r.PathValue("token")
	host := NormalizeHost(r.Host)
	if token == "" || host == "" {
		notFound(w)
		return
	}

	ctx := r.Context()
	domain, ok, err := h.store.DomainByHost(ctx, host)
	if err != nil {
		h.unavailable(w, "domain lookup failed", err)
		return
	}
	if !ok || !servesSubscriptions(domain) {
		notFound(w)
		return
	}

	grant, ok, err := h.store.GrantByTokenHash(ctx, TokenHash(token))
	if err != nil {
		h.unavailable(w, "grant lookup failed", err)
		return
	}
	if !ok || grant.TenantID != domain.TenantID {
		notFound(w)
		return
	}

	// F-113-b renders the Grant's stored lines here. An empty body is a valid
	// base64 subscription with no configs in it.
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
}

func notFound(w http.ResponseWriter) {
	http.Error(w, "not found", http.StatusNotFound)
}

func (h *Handler) unavailable(w http.ResponseWriter, msg string, err error) {
	h.log.Error(msg, "error", err)
	http.Error(w, "unavailable", http.StatusServiceUnavailable)
}
