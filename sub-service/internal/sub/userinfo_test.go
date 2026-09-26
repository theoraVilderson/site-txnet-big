package sub

import (
	"io"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// The invariant this row turns on (F-609, catalog §7.5): every `200` carries
// `Subscription-Userinfo` so a client app shows the Grant's remaining quota
// natively, and a Grant that is not active is answered with an empty but
// valid body showing zero remaining — never a 4xx, which apps handle badly.

const gib = int64(1) << 30

func grantWith(g Grant) *fakeStore {
	s := storeWith(live("healthy", "u-1", "vless://one"))
	g.ID, g.TenantID = "g-1", tenantA
	s.grants[hashOf(token)] = g
	return s
}

func TestAPrepaidGrantShowsItsLimitPlusAdjustmentsAndItsEnd(t *testing.T) {
	ends := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	res := get(t, grantWith(Grant{Status: "active", BillingMode: "prepaid",
		ConsumedBytes: 3 * gib, TrafficLimit: "53687091200", TrafficAdjustment: 2 * gib, EndsAt: &ends}),
		"/sub/"+token, "")
	want := "upload=0; download=3221225472; total=55834574848; expire=1792843200"
	if got := res.Header.Get("Subscription-Userinfo"); got != want {
		t.Fatalf("Subscription-Userinfo = %q, want %q", got, want)
	}
	if lines := decoded(t, res); len(lines) != 1 {
		t.Errorf("body = %v, want the one served line", lines)
	}
}

func TestNoFixedCapIsUnlimitedAndNoEndIsNoExpiry(t *testing.T) {
	for name, g := range map[string]Grant{
		"metered":          {BillingMode: "metered", TrafficLimit: "1073741824"},
		"no traffic quota": {BillingMode: "prepaid"},
		"unreadable limit": {BillingMode: "prepaid", TrafficLimit: "a lot"},
	} {
		g.Status, g.ConsumedBytes = "active", 5
		res := get(t, grantWith(g), "/sub/"+token, "")
		if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=5; total=0; expire=0" {
			t.Errorf("%s: Subscription-Userinfo = %q, want total=0 (unlimited) and expire=0", name, got)
		}
	}
}

// F-111-s: a Grant sold with unlimited traffic keeps the catalog's
// `limit = 0` in its quotas, and read as a cap that is `total=1` — an app
// showing "0 B left" to a user who bought everything. The flag says what the
// 0 means (entitlement invariant 15); an inactive one still shows empty.
func TestAnUnlimitedGrantIsUnlimitedInTheApp(t *testing.T) {
	g := Grant{Status: "active", BillingMode: "prepaid", ConsumedBytes: 7 * gib,
		TrafficLimit: "0", TrafficUnlimited: true}
	res := get(t, grantWith(g), "/sub/"+token, "")
	if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=7516192768; total=0; expire=0" {
		t.Fatalf("Subscription-Userinfo = %q, want total=0 (unlimited) and expire=0 (no end)", got)
	}
	g.Status = "suspended"
	res = get(t, grantWith(g), "/sub/"+token, "")
	if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=7516192768; total=7516192768; expire=0" {
		t.Fatalf("suspended: Subscription-Userinfo = %q, want zero remaining, never total=0", got)
	}
}

func TestAnAdjustmentBelowTheLimitNeverReadsAsUnlimited(t *testing.T) {
	res := get(t, grantWith(Grant{Status: "active", BillingMode: "prepaid",
		TrafficLimit: "100", TrafficAdjustment: -500}), "/sub/"+token, "")
	if got := res.Header.Get("Subscription-Userinfo"); got != "upload=0; download=0; total=1; expire=0" {
		t.Fatalf("Subscription-Userinfo = %q, want total=1: total=0 is what an app reads as unlimited", got)
	}
}

func TestAnInactiveGrantIsAnEmptyBodyWithZeroRemaining(t *testing.T) {
	ends := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	for _, status := range []string{"pending", "suspended", "exhausted", "expired", "cancelled"} {
		for _, consumed := range []int64{0, 7 * gib} {
			store := &countingStore{fakeStore: grantWith(Grant{Status: status, BillingMode: "metered",
				ConsumedBytes: consumed, EndsAt: &ends})}
			res := get(t, store, "/sub/"+token, "")
			if res.StatusCode != http.StatusOK {
				t.Fatalf("%s: status = %d, want 200 — never a 4xx", status, res.StatusCode)
			}
			if body, _ := io.ReadAll(res.Body); len(body) != 0 {
				t.Errorf("%s: body = %q, want empty: no config of a Grant that is not active is served", status, body)
			}
			if store.reads != 0 {
				t.Errorf("%s: config reads = %d, want 0", status, store.reads)
			}
			used := max(consumed, 1)
			want := "upload=0; download=" + strconv.FormatInt(used, 10) + "; total=" + strconv.FormatInt(used, 10) + "; expire=1788220800"
			if got := res.Header.Get("Subscription-Userinfo"); got != want {
				t.Errorf("%s, consumed %d: Subscription-Userinfo = %q, want %q (download = total: zero remaining, never 0 = unlimited)",
					status, consumed, got, want)
			}
		}
	}
}

func TestACachedAnswerCarriesTheSameUserinfo(t *testing.T) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	r.store.grants[hashOf(token)] = Grant{ID: "g-1", TenantID: tenantA, Status: "active",
		BillingMode: "prepaid", ConsumedBytes: 9, TrafficLimit: "10"}
	first, _ := r.get(t)
	second, _ := r.get(t)
	if r.store.reads != 1 {
		t.Fatalf("config reads = %d, want 1 (the second answer is cached)", r.store.reads)
	}
	want := "upload=0; download=9; total=10; expire=0"
	for i, res := range []*http.Response{first, second} {
		if got := res.Header.Get("Subscription-Userinfo"); got != want {
			t.Errorf("answer %d: Subscription-Userinfo = %q, want %q", i+1, got, want)
		}
	}
}
