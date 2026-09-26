// Package sub serves `GET /sub/{token}` (F-113, ADR-0082): one link per Grant,
// answered only on a subscription domain of the Grant's own tenant.
//
// It is the one surface of this service reachable from the edge, and it is
// read-only: the token in the path is the only authentication, no cookie is
// set or read and no CORS header is ever sent (catalog C-16). The body is the
// Grant's stored link lines (F-113-b, render.go); it never asks a panel.
package sub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// Domain is a `tenant.tenant_domain` row, as much of it as decides whether a
// host may serve subscriptions.
type Domain struct {
	TenantID           string
	Purpose            string
	DomainType         string
	VerificationStatus string
}

// Grant is an `entitlement.grant` row, as much of it as `/sub` reads.
type Grant struct {
	ID       string
	TenantID string
	Status   string
	// What `Subscription-Userinfo` is built from (F-609, userinfo.go).
	BillingMode   string
	ConsumedBytes int64
	// TrafficLimit is `quotas.traffic_bytes.limit` as text; empty when the
	// Grant has no traffic quota.
	TrafficLimit string
	// TrafficAdjustment is the sum of the Grant's `traffic_bytes`
	// QuotaAdjustments that have not expired.
	TrafficAdjustment int64
	// TrafficUnlimited is `grant.trafficUnlimited` (F-111-q): the Grant was
	// sold with unlimited traffic, and its `limit` of 0 is not a cap.
	TrafficUnlimited bool
	// EndsAt is nil for a permanent Grant.
	EndsAt *time.Time
}

// Store is every read this endpoint makes. Neither method writes; the
// connection behind the Postgres one is read-only at the session level.
type Store interface {
	// DomainByHost finds the row whose `domainValue` is the normalised host.
	DomainByHost(ctx context.Context, host string) (Domain, bool, error)
	// GrantByTokenHash finds the Grant whose `subscriptionTokenHash` is the
	// lowercase hex SHA-256 of the path token.
	GrantByTokenHash(ctx context.Context, hash string) (Grant, bool, error)
	// ConfigsOfGrant is every `network.config` of the Grant with its panel's
	// state, in a stable order; which of them are served is decided here.
	ConfigsOfGrant(ctx context.Context, grantID string) ([]Config, error)
}

// Handler serves the subscription endpoint.
type Handler struct {
	store Store
	cache RenderCache
	log   *slog.Logger
	// now is the clock a tenant's `graceEndsAt` is judged against.
	now func() time.Time
}

// New builds the handler. With no cache every request renders from Postgres.
func New(store Store, log *slog.Logger) *Handler {
	return &Handler{store: store, cache: RenderCache{TTL: defaultTTL}, log: log, now: time.Now}
}

// defaultTTL is the TTL a handler without a configured cache still announces.
const defaultTTL = time.Hour

// WithCache puts the Redis render cache (F-113-c) in front of the reads.
func (h *Handler) WithCache(c RenderCache) *Handler {
	h.cache = c
	return h
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
	format := DetectFormat(r)
	key := h.cache.key(TokenHash(token), format, host)
	if e, live, ok := h.cache.lookup(ctx, h.log, key); ok {
		if !subscriptionLinkAllowed(live.Tenant, h.now()) {
			h.refuseTenant(w, format, e.Grant, live)
			return
		}
		h.write(w, e.Body, e.ContentType, userinfo(e.Grant, live.Usage))
		return
	}
	// Taken before the first read, so a write committed while this render
	// reads is stamped after it (cache.go).
	built, cacheable := h.cache.begin(ctx, h.log)

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

	// Judged on every answer, a render included; a refusal is not cached, so
	// a reactivated tenant's next answer is its body again (F-113-e).
	live := h.cache.live(ctx, h.log, grant)
	if !subscriptionLinkAllowed(live.Tenant, h.now()) {
		h.refuseTenant(w, format, grant, live)
		return
	}

	// A Grant that is not active serves nothing, and says so with a 200 and
	// zero remaining: a client app handles a 4xx badly (F-609).
	var configs []Config
	if grant.Status == "active" {
		configs, err = h.store.ConfigsOfGrant(ctx, grant.ID)
		if err != nil {
			// Not an empty body: an app that reads one drops every server it had.
			h.unavailable(w, "config lookup failed", err)
			return
		}
	}
	body, contentType := render(format, servedLines(configs))
	h.write(w, body, contentType, userinfo(grant, live.Usage))
	if cacheable {
		h.cache.store(ctx, h.log, key, entry{
			Built:       built,
			Deps:        h.cache.deps(domain.TenantID, grant.ID, configs),
			ContentType: contentType,
			Grant:       grant,
			Body:        body,
		})
	}
}

// write sends a `200`. `Profile-Update-Interval` is the cache TTL in hours
// (catalog §7.5): a client app refetches no sooner than an entry could expire.
func (h *Handler) write(w http.ResponseWriter, body []byte, contentType, info string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Subscription-Userinfo", info)
	w.Header().Set("Profile-Update-Interval", strconv.Itoa(h.cache.updateIntervalHours()))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// refuseTenant is the answer a tenant the gate closes gets (F-113-e): what an
// inactive Grant gets — a `200`, an empty body in the format asked for, zero
// remaining — never a 4xx, which a client app may read as a deleted link.
func (h *Handler) refuseTenant(w http.ResponseWriter, f Format, g Grant, live liveState) {
	g.Status = "tenant_refused" // any status but active: userinfo's zero remaining
	body, contentType := render(f, nil)
	h.write(w, body, contentType, userinfo(g, live.Usage))
}

func notFound(w http.ResponseWriter) {
	http.Error(w, "not found", http.StatusNotFound)
}

func (h *Handler) unavailable(w http.ResponseWriter, msg string, err error) {
	h.log.Error(msg, "error", err)
	http.Error(w, "unavailable", http.StatusServiceUnavailable)
}
