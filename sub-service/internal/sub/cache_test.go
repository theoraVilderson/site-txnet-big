package sub

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"sub-service/internal/cache"
)

// The invariant this row turns on (F-113-c, catalog §7.5 + C-07, ADR-0083):
// a cached render is served, without a Postgres read, exactly while nothing it
// was built from has been stamped as changed since its build began — the
// Grant and its configs, its tenant's domains, every panel it has a config on.
// A change heard mid-build outdates the entry being built. And the cache is
// never the only way to answer: no listener or no Redis means Postgres.

const prefix = "txnet:auth:v2:"

// fakeRedis is a Redis with a clock the test moves by hand.
type fakeRedis struct {
	now    int64
	values map[string][]byte
	err    error
}

func newRedis() *fakeRedis { return &fakeRedis{now: 1_000_000, values: map[string][]byte{}} }

func (f *fakeRedis) Get(_ context.Context, key string) ([]byte, bool, error) {
	if f.err != nil {
		return nil, false, f.err
	}
	v, ok := f.values[key]
	return v, ok, nil
}

func (f *fakeRedis) MGet(_ context.Context, keys ...string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = string(f.values[k])
	}
	return out, nil
}

func (f *fakeRedis) Set(_ context.Context, key string, value []byte, _ time.Duration) error {
	if f.err != nil {
		return f.err
	}
	f.values[key] = value
	return nil
}

func (f *fakeRedis) Now(context.Context) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.now++
	return f.now, nil
}

// stamp is what the listener does on a notification: the Redis time, now.
func (f *fakeRedis) stamp(key string) {
	f.now++
	f.values[key] = []byte(strconv.FormatInt(f.now, 10))
}

// countingStore counts the config reads — the read a cache hit must not make —
// and can run a hook in the middle of one, as a write committing mid-render.
type countingStore struct {
	*fakeStore
	reads  int
	during func()
}

func (s *countingStore) ConfigsOfGrant(ctx context.Context, grantID string) ([]Config, error) {
	s.reads++
	configs, err := s.fakeStore.ConfigsOfGrant(ctx, grantID)
	if s.during != nil {
		s.during()
		s.during = nil
	}
	return configs, err
}

type rig struct {
	store *countingStore
	redis *fakeRedis
	live  bool
	h     *Handler
}

func newRig(configs ...Config) *rig {
	r := &rig{store: &countingStore{fakeStore: storeWith(configs...)}, redis: newRedis(), live: true}
	r.h = New(r.store, discard()).WithCache(RenderCache{
		Store: r.redis, Prefix: prefix, TTL: 6 * time.Hour,
		Live: func() bool { return r.live },
	})
	return r
}

func (r *rig) get(t *testing.T) (*http.Response, []string) {
	t.Helper()
	mux := http.NewServeMux()
	r.h.Register(mux)
	req := httptest.NewRequest(http.MethodGet, "/sub/"+token, nil)
	req.Host = "sub.alpha.com"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	res := rec.Result()
	return res, decoded(t, res)
}

func onPanel(panelID string, c Config) Config {
	c.PanelID = panelID
	return c
}

func TestSecondRequestIsServedFromCacheWithoutAPostgresRead(t *testing.T) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	_, first := r.get(t)
	res, second := r.get(t)
	if r.store.reads != 1 {
		t.Fatalf("config reads = %d, want 1 (the second answer is the cached render)", r.store.reads)
	}
	if len(second) != 1 || second[0] != first[0] {
		t.Fatalf("cached body = %v, want %v", second, first)
	}
	if got := res.Header.Get("Profile-Update-Interval"); got != "6" {
		t.Errorf("Profile-Update-Interval = %q, want the TTL in hours, 6", got)
	}
}

func TestAStampAfterTheBuildOutdatesTheEntry(t *testing.T) {
	for _, tc := range []struct {
		name string
		key  string
	}{
		{"the Grant or one of its configs", cache.ChangedKey(prefix, cache.KindGrant, "g-1")},
		{"a domain of its tenant", cache.ChangedKey(prefix, cache.KindTenant, tenantA)},
		{"a panel it has a served config on", cache.ChangedKey(prefix, cache.KindPanel, "p-1")},
		{"a panel it has a config on that is not served", cache.ChangedKey(prefix, cache.KindPanel, "p-down")},
		{"everything (a listener reconnected)", cache.ChangedAllKey(prefix)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(
				onPanel("p-1", live("healthy", "u-1", "vless://one")),
				onPanel("p-down", live("down", "u-2", "vless://two")),
			)
			r.get(t)
			r.redis.stamp(tc.key)
			r.store.configs["g-1"][1].PanelState = "healthy"
			_, body := r.get(t)
			if r.store.reads != 2 {
				t.Fatalf("config reads = %d, want 2: a change stamped after the build must re-render", r.store.reads)
			}
			if len(body) != 2 {
				t.Fatalf("body = %v, want the re-rendered two lines", body)
			}
		})
	}
}

func TestAStampOnSomethingElseLeavesTheEntry(t *testing.T) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	r.get(t)
	r.redis.stamp(cache.ChangedKey(prefix, cache.KindPanel, "p-other"))
	r.redis.stamp(cache.ChangedKey(prefix, cache.KindGrant, "g-other"))
	r.redis.stamp(cache.ChangedKey(prefix, cache.KindTenant, tenantB))
	r.get(t)
	if r.store.reads != 1 {
		t.Fatalf("config reads = %d, want 1: another Grant's, panel's or tenant's change is not this one's", r.store.reads)
	}
}

// A write that commits while a render is reading is heard after the render
// began, so the entry that render stores is already dead.
func TestAChangeHeardMidRenderOutdatesTheEntryBeingBuilt(t *testing.T) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	r.store.during = func() { r.redis.stamp(cache.ChangedKey(prefix, cache.KindPanel, "p-1")) }
	r.get(t)
	r.get(t)
	if r.store.reads != 2 {
		t.Fatalf("config reads = %d, want 2: the entry built across a change must not be served", r.store.reads)
	}
}

func TestNoListenerMeansNoCache(t *testing.T) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	r.live = false
	r.get(t)
	r.get(t)
	if r.store.reads != 2 {
		t.Fatalf("config reads = %d, want 2: nothing is told what changed, so nothing is cached", r.store.reads)
	}
	if len(r.redis.values) != 0 {
		t.Fatalf("cache written while no listener was live: %v", r.redis.values)
	}
}

func TestRedisDownIsAnswerFromPostgres(t *testing.T) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	r.redis.err = errors.New("connection refused")
	res, body := r.get(t)
	if res.StatusCode != http.StatusOK || len(body) != 1 {
		t.Fatalf("status %d body %v, want 200 with the line: Redis is a cache, never a dependency", res.StatusCode, body)
	}
}

func TestARefusalIsNeverCached(t *testing.T) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	r.store.grants = map[string]Grant{}
	mux := http.NewServeMux()
	r.h.Register(mux)
	req := httptest.NewRequest(http.MethodGet, "/sub/"+token, nil)
	req.Host = "sub.alpha.com"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if len(r.redis.values) != 0 {
		t.Fatalf("a 404 was cached: %v", r.redis.values)
	}
}
