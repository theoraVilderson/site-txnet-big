package sub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// The Go half of `contracts/tenant/subscription-link.json` (F-113-g): the
// `subscriptionLink` column tenant.go copies from shared-core's
// `TenantStatusPolicy`, and how a raw `tenant:status` value is judged. The
// TypeScript half is `subscription-link.contract.spec.ts`; a column changed on
// one side only turns one of them red.

type linkFixture struct {
	Column     map[string]any `json:"column"`
	Onboarding any            `json:"onboarding"`
	Now        string         `json:"now"`
	Cases      []struct {
		Name, Raw string
		Allowed   bool
	} `json:"cases"`
}

func readLinkFixture(t *testing.T) linkFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean("../../../contracts/tenant/subscription-link.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var f linkFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return f
}

// ruleOf reads the fixture's spelling: true, false or "hold".
func ruleOf(t *testing.T, v any) linkRule {
	t.Helper()
	switch v {
	case true:
		return linkAllowed
	case false:
		return linkRefused
	case "hold":
		return linkHold
	}
	t.Fatalf("fixture rule %v is not true, false or \"hold\"", v)
	return 0
}

func TestTheColumnMatchesTheSharedFixture(t *testing.T) {
	f := readLinkFixture(t)
	want := map[string]linkRule{}
	for status, v := range f.Column {
		want[status] = ruleOf(t, v)
	}
	if !reflect.DeepEqual(subscriptionLinkColumn, want) {
		t.Errorf("subscriptionLinkColumn = %v, fixture says %v", subscriptionLinkColumn, want)
	}
	if got := ruleOf(t, f.Onboarding); subscriptionLinkOnboarding != got {
		t.Errorf("subscriptionLinkOnboarding = %v, fixture says %v", subscriptionLinkOnboarding, got)
	}
}

func TestRawStatesAreJudgedAsTheSharedFixtureSays(t *testing.T) {
	f := readLinkFixture(t)
	now, err := time.Parse(time.RFC3339Nano, f.Now)
	if err != nil {
		t.Fatalf("fixture now: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixture declares no cases")
	}
	for _, tc := range f.Cases {
		if got := subscriptionLinkAllowed(tc.Raw, now); got != tc.Allowed {
			t.Errorf("%s: allowed = %v, fixture says %v (raw %s)", tc.Name, got, tc.Allowed, tc.Raw)
		}
	}
}
