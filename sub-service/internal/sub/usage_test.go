package sub

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"sub-service/internal/cache"
)

// The invariant this row turns on (F-609-b): `Subscription-Userinfo`'s
// `download` is the Grant's live total from `sub:usage:<grantId>` (written by
// metering-service after each charge commits, F-609-a) on every answer, cached
// or not — so a cached body no longer holds the used figure back by up to the
// TTL. The key is never the truth: missing, unreadable, lower than what
// Postgres said, or Redis failing, the render's own figure is used. And a
// cache hit stays two Redis round trips (contract p99 guarantee).

// callCounter counts Redis round trips.
type callCounter struct {
	*fakeRedis
	gets, mgets int
}

func (c *callCounter) Get(ctx context.Context, key string) ([]byte, bool, error) {
	c.gets++
	return c.fakeRedis.Get(ctx, key)
}

func (c *callCounter) MGet(ctx context.Context, keys ...string) ([]string, error) {
	c.mgets++
	return c.fakeRedis.MGet(ctx, keys...)
}

func usageRig(consumed int64) (*rig, *callCounter) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	r.store.grants[hashOf(token)] = Grant{ID: "g-1", TenantID: tenantA, Status: "active",
		BillingMode: "prepaid", ConsumedBytes: consumed, TrafficLimit: "100"}
	counter := &callCounter{fakeRedis: r.redis}
	r.h.cache.Store = counter
	return r, counter
}

func usageKey() string { return cache.UsageKey(prefix, "g-1") }

func TestLiveUsageIsShownOnACachedAnswer(t *testing.T) {
	r, counter := usageRig(9)
	first, _ := r.get(t)
	if got := first.Header.Get("Subscription-Userinfo"); got != "upload=0; download=9; total=100; expire=0" {
		t.Fatalf("first answer: Subscription-Userinfo = %q, want the render's figure (no key yet)", got)
	}
	r.redis.values[usageKey()] = []byte("42")
	counter.gets, counter.mgets = 0, 0
	second, _ := r.get(t)
	if r.store.reads != 1 {
		t.Fatalf("config reads = %d, want 1: the second answer is cached", r.store.reads)
	}
	if got := second.Header.Get("Subscription-Userinfo"); got != "upload=0; download=42; total=100; expire=0" {
		t.Errorf("cached answer: Subscription-Userinfo = %q, want download=42 from %s", got, usageKey())
	}
	if counter.gets != 1 || counter.mgets != 1 {
		t.Errorf("a cache hit made %d GET and %d MGET, want one of each: usage rides the stamps' MGET",
			counter.gets, counter.mgets)
	}
}

func TestLiveUsageIsShownOnARender(t *testing.T) {
	r, _ := usageRig(9)
	r.redis.values[usageKey()] = []byte("42")
	res, _ := r.get(t)
	if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=42; total=100; expire=0" {
		t.Errorf("Subscription-Userinfo = %q, want download=42", got)
	}
	r.live = false // no listener: no cache, but the usage key is not the cache
	res, _ = r.get(t)
	if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=42; total=100; expire=0" {
		t.Errorf("no listener: Subscription-Userinfo = %q, want download=42", got)
	}
}

func TestTheKeyNeverLowersTheRendersFigure(t *testing.T) {
	for name, v := range map[string]string{"lower": "3", "unreadable": "lots", "negative": "-5"} {
		r, _ := usageRig(9)
		r.redis.values[usageKey()] = []byte(v)
		for i := 0; i < 2; i++ { // the render, then the cached answer
			res, _ := r.get(t)
			if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=9; total=100; expire=0" {
				t.Errorf("%s key, answer %d: Subscription-Userinfo = %q, want the render's download=9", name, i+1, got)
			}
		}
	}
}

func TestAnInactiveGrantStillShowsZeroRemainingWithLiveUsage(t *testing.T) {
	r, _ := usageRig(9)
	g := r.store.grants[hashOf(token)]
	g.Status = "exhausted"
	r.store.grants[hashOf(token)] = g
	r.redis.values[usageKey()] = []byte("120")
	for i := 0; i < 2; i++ {
		res, _ := r.get(t)
		if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=120; total=120; expire=0" {
			t.Errorf("answer %d: Subscription-Userinfo = %q, want download = total = 120", i+1, got)
		}
	}
}

func TestRedisDownShowsTheRendersFigure(t *testing.T) {
	r, _ := usageRig(9)
	r.redis.values[usageKey()] = []byte("42")
	r.redis.err = context.DeadlineExceeded
	res, _ := r.get(t)
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=9; total=100; expire=0" {
		t.Errorf("Subscription-Userinfo = %q, want the render's download=9", got)
	}
}

// The Go half of `contracts/redis/keyspace.json` `subKeyCases`: the keys are
// written in TypeScript (shared-core `UnscopedRedisKeys`) and read here, and a
// name built differently on one side reads as "no live usage" forever.
func TestUsageKeyMatchesTheSharedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean("../../../contracts/redis/keyspace.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		SubKeyCases []struct{ Builder, ID, Key string } `json:"subKeyCases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	// tenantStatus: a name built differently here is a key that is always
	// missing, and missing refuses nobody — the tenant gate (F-113-e) would be
	// off with no error anywhere.
	builders := map[string]func(prefix, id string) string{
		"subUsage":     cache.UsageKey,
		"tenantStatus": cache.TenantStatusKey,
	}
	if len(fixture.SubKeyCases) == 0 {
		t.Fatal("fixture declares no subKeyCases")
	}
	for _, tc := range fixture.SubKeyCases {
		build, ok := builders[tc.Builder]
		if !ok {
			t.Errorf("fixture declares builder %q, which sub-service does not have", tc.Builder)
			continue
		}
		if got, want := build(prefix, tc.ID), prefix+tc.Key; got != want {
			t.Errorf("%s(%q) = %q, fixture says %q", tc.Builder, tc.ID, got, want)
		}
	}
}
