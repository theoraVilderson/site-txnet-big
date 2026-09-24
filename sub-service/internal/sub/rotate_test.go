package sub

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"sub-service/internal/cache"
)

// F-113-d (catalog §7.5): a rotated token stops answering at once, not when
// its cached render expires. Nothing deletes the old token's entries by key:
// `GrantService.rotateToken` rewrites `subscriptionTokenHash`, the Grant
// trigger (ADR-0083) notifies `{"kind":"grant"}` when that commits, and the
// listener's stamp outdates every entry built for the Grant — under the old
// token's hash as under any other. Both halves are proved here: the handler
// on that stamp, and the trigger that makes it.

const rotated = "rotated-subscription-token-0123456789"

func (r *rig) getToken(t *testing.T, tok string) *http.Response {
	t.Helper()
	mux := http.NewServeMux()
	r.h.Register(mux)
	req := httptest.NewRequest(http.MethodGet, "/sub/"+tok, nil)
	req.Host = "sub.alpha.com"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec.Result()
}

func TestARotatedTokenStopsAnsweringWhileItsRenderIsStillCached(t *testing.T) {
	r := newRig(onPanel("p-1", live("healthy", "u-1", "vless://one")))
	if res := r.getToken(t, token); res.StatusCode != http.StatusOK {
		t.Fatalf("before rotation: status %d, want 200", res.StatusCode)
	}

	// rotateToken's commit: the row answers to the new hash only, and the
	// trigger's notification reaches the listener as the Grant's stamp.
	g := r.store.grants[hashOf(token)]
	delete(r.store.grants, hashOf(token))
	r.store.grants[hashOf(rotated)] = g
	r.redis.stamp(cache.ChangedKey(prefix, cache.KindGrant, g.ID))

	if res := r.getToken(t, token); res.StatusCode != http.StatusNotFound {
		t.Fatalf("old token after rotation: status %d, want 404 — its cached render was served", res.StatusCode)
	}
	res := r.getToken(t, rotated)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("new token: status %d, want 200", res.StatusCode)
	}
	if body := decoded(t, res); len(body) != 1 || body[0] != "vless://one" {
		t.Fatalf("new token body = %v, want the Grant's line", body)
	}
}

// The stamp above exists only because the Grant trigger watches the token
// column. Prisma owns the schema, so the trigger is read where it is declared:
// the last migration that (re)defines it, off disk.
func TestTheGrantTriggerFiresOnATokenRotation(t *testing.T) {
	sqls, _ := filepath.Glob("../../../txnet-backend/prisma/domains/migrations/*/migration.sql")
	sort.Strings(sqls)
	fn := lastMatch(t, sqls, regexp.MustCompile(
		`(?s)CREATE OR REPLACE FUNCTION entitlement\.notify_sub_grant_changed\(\).*?\$\$;`))
	trigger := lastMatch(t, sqls, regexp.MustCompile(
		`(?s)CREATE TRIGGER sub_grant_changed.*?;`))
	if !strings.Contains(fn, `OLD."subscriptionTokenHash" IS DISTINCT FROM NEW."subscriptionTokenHash"`) {
		t.Errorf("notify_sub_grant_changed does not notify on a token change:\n%s", fn)
	}
	if !regexp.MustCompile(`AFTER UPDATE OF [^;]*"subscriptionTokenHash"`).MatchString(trigger) {
		t.Errorf("sub_grant_changed does not fire on UPDATE OF \"subscriptionTokenHash\":\n%s", trigger)
	}
}

func lastMatch(t *testing.T, paths []string, re *regexp.Regexp) string {
	t.Helper()
	found := ""
	for _, path := range paths {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if m := re.FindAll(body, -1); len(m) > 0 {
			found = string(m[len(m)-1])
		}
	}
	if found == "" {
		t.Fatalf("no migration matches %s", re)
	}
	return found
}
