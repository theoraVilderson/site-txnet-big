package sub

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"sub-service/internal/cache"
)

// Cache is the Redis the render cache needs (F-113-c). `cache.Client` is the
// real one.
type Cache interface {
	Get(ctx context.Context, key string) ([]byte, bool, error)
	MGet(ctx context.Context, keys ...string) ([]string, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
	// Now is the Redis server's clock in microseconds.
	Now(ctx context.Context) (int64, error)
}

// RenderCache holds a rendered answer in Redis under catalog C-07's key, and
// serves it only while nothing it was built from has changed since.
//
// How "changed" is known (ADR-0083): Postgres triggers NOTIFY on every write
// that can change a render, and the listener stamps `sub:changed:<kind>:<id>`
// with the Redis time it heard of it. An entry records the Redis time taken
// **before** its first Postgres read and the stamps it depends on; it is
// served only while every one of those stamps is older than it. A write that
// committed after the build began is heard after it too, so its stamp is
// newer and the entry is dead; a write that committed before was read. Using
// one clock — Redis's — is what keeps two replicas' clocks out of it.
//
// C-07's key is `(grantId, healthyPanelSetHash, activeDomainSetHash,
// format)`. The Redis key is what a request knows before any read — token
// hash, format, host — and the other three are the entry's dependencies: the
// Grant's stamp, one stamp per panel it has a config on, and its tenant's
// (every domain change stamps the tenant).
type RenderCache struct {
	// Store is nil when there is no cache (tests); every request then renders.
	Store  Cache
	Prefix string
	// TTL is how long an entry lives, and what `Profile-Update-Interval`
	// tells a client app; a whole number of hours (config).
	TTL time.Duration
	// Live reports whether this process is being told what changed right now.
	// While it is not, the cache is neither read nor written: an entry could
	// outlive a change nobody stamped.
	Live func() bool
}

// renderRevision is part of every render key. Bump it when the same stored
// lines render to a different body, so a replica still running the old code
// during a rolling deploy cannot serve its entries to the new one's requests.
const renderRevision = "6"

// entry is one cached answer.
type entry struct {
	// Built is the Redis time, in microseconds, taken before the first read.
	Built int64 `json:"built"`
	// Deps are the stamp keys this answer depends on, prefix included.
	Deps        []string `json:"deps"`
	ContentType string   `json:"contentType"`
	// Grant is what `Subscription-Userinfo` is built from. The header is
	// rebuilt on every answer with the live usage (F-609-b): `consumedBytes`
	// fires no trigger, so the figure read here is only the floor.
	Grant Grant  `json:"grant"`
	Body  []byte `json:"body"`
}

func (c RenderCache) enabled() bool {
	return c.Store != nil && (c.Live == nil || c.Live())
}

func (c RenderCache) key(tokenHash string, f Format, host string) string {
	return cache.RenderKey(c.Prefix, renderRevision, tokenHash, string(f), host)
}

// liveState is what is read from Redis on every answer, cached or not: the
// Grant's live usage (F-609-b) and its tenant's status (F-113-e). Neither is
// the cache, and neither is ever baked into an entry.
type liveState struct {
	// Usage is `sub:usage:<grantId>`; 0 when there is none.
	Usage int64
	// Tenant is the raw `tenant:status:<tenantId>`; empty when there is none.
	Tenant string
}

func (c RenderCache) liveKeys(g Grant) []string {
	return []string{cache.UsageKey(c.Prefix, g.ID), cache.TenantStatusKey(c.Prefix, g.TenantID)}
}

// lookup returns the cached answer for key if it is still fresh, with the
// live state read in the same `MGET` as the stamps, so a hit stays two round
// trips. Any Redis failure is a miss: the answer is rendered from Postgres
// instead.
func (c RenderCache) lookup(ctx context.Context, log *slog.Logger, key string) (entry, liveState, bool) {
	if !c.enabled() {
		return entry{}, liveState{}, false
	}
	raw, ok, err := c.Store.Get(ctx, key)
	if err != nil {
		log.Warn("render cache read failed", "error", err)
		return entry{}, liveState{}, false
	}
	if !ok {
		return entry{}, liveState{}, false
	}
	var e entry
	if err := json.Unmarshal(raw, &e); err != nil || len(e.Deps) == 0 || e.Grant.ID == "" || e.Grant.TenantID == "" {
		return entry{}, liveState{}, false
	}
	values, err := c.Store.MGet(ctx, append(e.Deps, c.liveKeys(e.Grant)...)...)
	if err != nil {
		log.Warn("render cache stamp read failed", "error", err)
		return entry{}, liveState{}, false
	}
	stamps, rest := values[:len(e.Deps)], values[len(e.Deps):]
	return e, liveState{Usage: parseUsage(rest[0]), Tenant: rest[1]}, fresh(e.Built, stamps)
}

// live is the live state for a render, in one `MGET` taken once the Grant is
// known, so a refused tenant reads no configs. It is not the cache, so it is
// read with no listener too; Redis failing is the zero state — no usage
// figure, and no tenant state, which refuses nobody.
func (c RenderCache) live(ctx context.Context, log *slog.Logger, g Grant) liveState {
	if c.Store == nil {
		return liveState{}
	}
	values, err := c.Store.MGet(ctx, c.liveKeys(g)...)
	if err != nil {
		log.Warn("live state read failed", "error", err)
		return liveState{}
	}
	return liveState{Usage: parseUsage(values[0]), Tenant: values[1]}
}

// parseUsage reads the key's decimal total; anything else is "no figure".
func parseUsage(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// fresh is the whole invalidation rule: every stamp an entry depends on is
// older than the entry. A missing stamp is "never changed"; one that cannot
// be read is a change.
func fresh(built int64, stamps []string) bool {
	for _, s := range stamps {
		if s == "" {
			continue
		}
		at, err := strconv.ParseInt(s, 10, 64)
		if err != nil || at >= built {
			return false
		}
	}
	return true
}

// begin is the Redis time a render starts at, taken before its first Postgres
// read. ok=false means this render is not cached.
func (c RenderCache) begin(ctx context.Context, log *slog.Logger) (int64, bool) {
	if !c.enabled() {
		return 0, false
	}
	now, err := c.Store.Now(ctx)
	if err != nil {
		log.Warn("render cache clock read failed", "error", err)
		return 0, false
	}
	return now, true
}

// deps are the stamp keys of everything a render read: every stamp, the
// Grant (its row and its configs), its tenant (its domains) and every panel
// it has a config on — served or not, since a panel coming back changes the
// body as much as one going down.
func (c RenderCache) deps(tenantID, grantID string, configs []Config) []string {
	keys := []string{
		cache.ChangedAllKey(c.Prefix),
		cache.ChangedKey(c.Prefix, cache.KindGrant, grantID),
		cache.ChangedKey(c.Prefix, cache.KindTenant, tenantID),
	}
	seen := map[string]bool{}
	for _, cfg := range configs {
		if cfg.PanelID == "" || seen[cfg.PanelID] {
			continue
		}
		seen[cfg.PanelID] = true
		keys = append(keys, cache.ChangedKey(c.Prefix, cache.KindPanel, cfg.PanelID))
	}
	return keys
}

func (c RenderCache) store(ctx context.Context, log *slog.Logger, key string, e entry) {
	raw, err := json.Marshal(e)
	if err != nil {
		return
	}
	if err := c.Store.Set(ctx, key, raw, c.TTL); err != nil {
		log.Warn("render cache write failed", "error", err)
	}
}

// updateIntervalHours is `Profile-Update-Interval`: the TTL, in the hours the
// header is read in. Never below one.
func (c RenderCache) updateIntervalHours() int {
	h := int(c.TTL / time.Hour)
	if h < 1 {
		h = 1
	}
	return h
}
