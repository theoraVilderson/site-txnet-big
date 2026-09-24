package sub

import (
	"context"
	"testing"
	"time"

	"sub-service/internal/cache"
)

// The invariant this row turns on (F-113-e, tenant `rules.md`): `/sub` is
// served only while `TenantStatusPolicy`'s `subscriptionLink` column allows
// the Grant's tenant — `trial`/`active` yes, `suspended` until `graceEndsAt`,
// `terminated` no, and no while onboarding. A refused tenant gets the inactive
// Grant's answer: `200`, an empty body, zero remaining, never a 4xx. The gate
// is judged on every answer, cached or not, since the grace ends with no write
// anybody could stamp; and a missing, unreadable or unreachable state refuses
// nobody (rules.md #6).

var gateNow = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)

func gateRig() *rig {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	r.store.grants[hashOf(token)] = Grant{ID: "g-1", TenantID: tenantA, Status: "active",
		BillingMode: "prepaid", ConsumedBytes: 9, TrafficLimit: "100"}
	r.h.now = func() time.Time { return gateNow }
	return r
}

func setTenantState(r *rig, raw string) {
	r.redis.values[cache.TenantStatusKey(prefix, tenantA)] = []byte(raw)
}

const (
	servedInfo  = "upload=0; download=9; total=100; expire=0"
	refusedInfo = "upload=0; download=9; total=9; expire=0"
)

func expectServed(t *testing.T, r *rig, why string) {
	t.Helper()
	res, lines := r.get(t)
	if res.StatusCode != 200 || len(lines) != 1 {
		t.Fatalf("%s: status %d, lines %v; want 200 with the Grant's line", why, res.StatusCode, lines)
	}
	if got := res.Header.Get("Subscription-Userinfo"); got != servedInfo {
		t.Errorf("%s: Subscription-Userinfo = %q, want %q", why, got, servedInfo)
	}
}

func expectRefused(t *testing.T, r *rig, why string) {
	t.Helper()
	res, lines := r.get(t)
	if res.StatusCode != 200 || len(lines) != 0 {
		t.Fatalf("%s: status %d, lines %v; want 200 with an empty body", why, res.StatusCode, lines)
	}
	if got := res.Header.Get("Subscription-Userinfo"); got != refusedInfo {
		t.Errorf("%s: Subscription-Userinfo = %q, want zero remaining %q", why, got, refusedInfo)
	}
}

func TestTheSubscriptionLinkColumnIsApplied(t *testing.T) {
	inGrace := gateNow.Add(time.Hour).Format(time.RFC3339Nano)
	pastGrace := gateNow.Add(-time.Millisecond).Format("2006-01-02T15:04:05.000Z07:00")
	served := map[string]string{
		"trial":                `{"status":"trial","graceEndsAt":null,"onboarding":false}`,
		"active":               `{"status":"active","graceEndsAt":null,"onboarding":false}`,
		"suspended, in grace":  `{"status":"suspended","graceEndsAt":"` + inGrace + `","onboarding":false}`,
		"missing onboarding":   `{"status":"active","graceEndsAt":null}`,
		"grace ends right now": `{"status":"suspended","graceEndsAt":"` + gateNow.Format(time.RFC3339) + `"}`,
		"an unknown status":    `{"status":"archived","graceEndsAt":null}`,
		"unreadable":           `not json`,
	}
	refused := map[string]string{
		"suspended, grace over": `{"status":"suspended","graceEndsAt":"` + pastGrace + `","onboarding":false}`,
		"suspended, no grace":   `{"status":"suspended","graceEndsAt":null,"onboarding":false}`,
		"terminated":            `{"status":"terminated","graceEndsAt":null,"onboarding":false}`,
		"active but onboarding": `{"status":"active","graceEndsAt":null,"onboarding":true}`,
		"trial but onboarding":  `{"status":"trial","graceEndsAt":null,"onboarding":true}`,
	}
	for name, raw := range served {
		r := gateRig()
		setTenantState(r, raw)
		expectServed(t, r, name)
	}
	for name, raw := range refused {
		r := gateRig()
		setTenantState(r, raw)
		expectRefused(t, r, name)
		if r.store.reads != 0 {
			t.Errorf("%s: %d config reads, want none for a refused tenant", name, r.store.reads)
		}
	}
}

func TestNoStateRefusesNobody(t *testing.T) {
	expectServed(t, gateRig(), "no key")
	r := gateRig()
	setTenantState(r, `{"status":"terminated","graceEndsAt":null}`)
	r.redis.err = context.DeadlineExceeded
	expectServed(t, r, "Redis down")
}

// A cached body is not a pass: the state is read in the hit's own MGET, so
// the gate costs a hit no round trip.
func TestACachedAnswerIsGatedToo(t *testing.T) {
	r := gateRig()
	counter := &callCounter{fakeRedis: r.redis}
	r.h.cache.Store = counter
	expectServed(t, r, "first answer")
	setTenantState(r, `{"status":"terminated","graceEndsAt":null}`)
	counter.gets, counter.mgets = 0, 0
	expectRefused(t, r, "terminated after the render")
	if counter.gets != 1 || counter.mgets != 1 {
		t.Errorf("a gated hit made %d GET and %d MGET, want one of each", counter.gets, counter.mgets)
	}
	setTenantState(r, `{"status":"active","graceEndsAt":null}`)
	expectServed(t, r, "reactivated")
	if r.store.reads != 1 {
		t.Errorf("config reads = %d, want 1: the refusal outdated no entry", r.store.reads)
	}
}

// Nothing is written when a grace runs out, so nothing is stamped: only the
// clock tells the cached answer it is over.
func TestTheGraceRunsOutOnACachedAnswer(t *testing.T) {
	r := gateRig()
	setTenantState(r, `{"status":"suspended","graceEndsAt":"`+gateNow.Add(time.Hour).Format(time.RFC3339)+`"}`)
	expectServed(t, r, "in grace")
	r.h.now = func() time.Time { return gateNow.Add(2 * time.Hour) }
	expectRefused(t, r, "grace over, entry still fresh")
}

func TestARefusedAnswerIsNotCached(t *testing.T) {
	r := gateRig()
	setTenantState(r, `{"status":"terminated","graceEndsAt":null}`)
	expectRefused(t, r, "terminated")
	setTenantState(r, `{"status":"active","graceEndsAt":null}`)
	expectServed(t, r, "reactivated")
}
