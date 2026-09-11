package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The Go half of the wire contract (ADR-0036, C-04).
//
// `contracts/http/wire.json` is hand-written and language-neutral. This file
// asserts that `headers.go` is exactly it, and
// `shared-core/src/lib/http/wire.contract.spec.ts` asserts the same of the
// TypeScript half. Nothing imports across the two languages — that is the
// whole problem — so a fixture plus a test on each side is what an import
// would have been.
//
// It also asserts the harder half: that a real /validate response carries
// exactly the declared set. A constant matching the fixture while the handler
// writes something else is a contract that is true on paper, and the drift
// that prompted ADR-0036 was precisely of that kind.
const wireFixturePath = "../../../../contracts/http/wire.json"

type wireFixture struct {
	IdentityHeaders          map[string]string `json:"identityHeaders"`
	AlwaysSetIdentityHeaders []string          `json:"alwaysSetIdentityHeaders"`
	ImpersonationHeaders     []string          `json:"impersonationHeaders"`
	GateHeaders              map[string]string `json:"gateHeaders"`
}

func loadWireFixture(t *testing.T) wireFixture {
	t.Helper()

	raw, err := os.ReadFile(filepath.Clean(wireFixturePath))
	if os.IsNotExist(err) {
		t.Fatalf("wire fixture %s is missing — it is hand-written and "+
			"checked in; restore it rather than regenerating it", wireFixturePath)
	}
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var fixture wireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(fixture.IdentityHeaders) == 0 {
		t.Fatalf("fixture %s declares no identity headers", wireFixturePath)
	}
	return fixture
}

// The fixture carries a `note` beside the real entries; it is prose, not a
// header name.
func withoutNote(block map[string]string) map[string]string {
	out := make(map[string]string, len(block))
	for k, v := range block {
		if k == "note" {
			continue
		}
		out[k] = v
	}
	return out
}

func TestContractIdentityHeaderNames(t *testing.T) {
	fixture := loadWireFixture(t)

	want := map[string]string{
		"userId":         HeaderUserID,
		"tenantId":       HeaderTenantID,
		"roleId":         HeaderRoleID,
		"sessionId":      HeaderSessionID,
		"permissions":    HeaderUserPermissions,
		"impersonated":   HeaderImpersonated,
		"impersonatedBy": HeaderImpersonatedBy,
	}

	got := withoutNote(fixture.IdentityHeaders)
	if len(got) != len(want) {
		t.Fatalf("fixture declares %d identity headers, headers.go has %d: %v vs %v",
			len(got), len(want), got, want)
	}
	for key, name := range want {
		if got[key] != name {
			t.Errorf("identityHeaders.%s = %q in the fixture, %q in headers.go",
				key, got[key], name)
		}
	}
}

func TestContractAnonymousMarkerName(t *testing.T) {
	fixture := loadWireFixture(t)

	if got := withoutNote(fixture.GateHeaders)["anonymous"]; got != HeaderAnonymous {
		t.Errorf("gateHeaders.anonymous = %q in the fixture, %q in headers.go",
			got, HeaderAnonymous)
	}
}

func TestContractHeaderGroups(t *testing.T) {
	fixture := loadWireFixture(t)

	assertSameOrder(t, "alwaysSetIdentityHeaders",
		fixture.AlwaysSetIdentityHeaders, AlwaysSetIdentityHeaders)
	assertSameOrder(t, "impersonationHeaders",
		fixture.ImpersonationHeaders, ImpersonationHeaders)
}

func assertSameOrder(t *testing.T, label string, fixture, code []string) {
	t.Helper()

	if len(fixture) != len(code) {
		t.Fatalf("%s: fixture has %d entries, headers.go has %d: %v vs %v",
			label, len(fixture), len(code), fixture, code)
	}
	for i := range fixture {
		if fixture[i] != code[i] {
			t.Errorf("%s[%d] = %q in the fixture, %q in headers.go",
				label, i, fixture[i], code[i])
		}
	}
}

// A real response, not just a constant. This is the half that catches a
// handler which agrees with the fixture in its declarations and writes
// something else on the wire.
func TestContractValidateResponseCarriesExactlyTheDeclaredHeaders(t *testing.T) {
	fixture := loadWireFixture(t)

	h, _ := newHandler(t, sessionActive, testEngine(t))
	w := call(t, h, sign(t, validClaims(nil), testSecret))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}

	for _, name := range fixture.AlwaysSetIdentityHeaders {
		if len(w.Header().Values(name)) == 0 {
			t.Errorf("/validate did not set %q, which the fixture declares", name)
		}
	}
	// Not impersonating: the conditional pair must be absent rather than
	// empty, because every consumer checks presence.
	for _, name := range fixture.ImpersonationHeaders {
		if len(w.Header().Values(name)) > 0 {
			t.Errorf("/validate set %q on a request that is not impersonated", name)
		}
	}
	// The marker says the gate ran and identified nobody. A success carrying
	// it would be claiming both at once.
	if len(w.Header().Values(withoutNote(fixture.GateHeaders)["anonymous"])) > 0 {
		t.Errorf("/validate set the anonymous marker on a successful identification")
	}

	assertNoUndeclaredHeaders(t, w.Header(), fixture)
}

func TestContractImpersonatedResponseCarriesThePair(t *testing.T) {
	fixture := loadWireFixture(t)

	h, _ := newHandler(t, sessionActive, testEngine(t))
	w := call(t, h, sign(t, validClaims(map[string]any{
		"isImpersonated": true,
		"impersonatedBy": "support-7",
	}), testSecret))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}

	for _, name := range fixture.ImpersonationHeaders {
		if w.Header().Get(name) == "" {
			t.Errorf("/validate did not set %q while impersonating", name)
		}
	}
	assertNoUndeclaredHeaders(t, w.Header(), fixture)
}

// The optional gate's one extra outcome: nobody is signed in, and the marker
// is set *instead of* the identity set rather than beside it.
func TestContractAnonymousResponseCarriesOnlyTheMarker(t *testing.T) {
	fixture := loadWireFixture(t)

	h, _ := newHandler(t, sessionActive, testEngine(t))
	w := callOptional(t, h, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}

	marker := withoutNote(fixture.GateHeaders)["anonymous"]
	if got := w.Header().Get(marker); got != "true" {
		t.Errorf("%s = %q, want \"true\"", marker, got)
	}
	for _, name := range fixture.AlwaysSetIdentityHeaders {
		if len(w.Header().Values(name)) > 0 {
			t.Errorf("anonymous 2xx carried %q; the marker replaces the identity set", name)
		}
	}
	assertNoUndeclaredHeaders(t, w.Header(), fixture)
}

// Every `X-` header on the response is one the fixture declares.
//
// This is the direction the other assertions cannot cover, and it is the one
// that actually rotted: `X-Actor-Id` lived in Traefik's strip list for months
// because nothing ever asked whether a header in a list was a header anyone
// wrote. A new header added here without a fixture entry is a header no
// consumer and no Traefik list knows about.
func assertNoUndeclaredHeaders(t *testing.T, headers http.Header, fixture wireFixture) {
	t.Helper()

	declared := map[string]bool{}
	for _, name := range withoutNote(fixture.IdentityHeaders) {
		declared[strings.ToLower(name)] = true
	}
	for _, name := range withoutNote(fixture.GateHeaders) {
		declared[strings.ToLower(name)] = true
	}

	for name := range headers {
		lower := strings.ToLower(name)
		if !strings.HasPrefix(lower, "x-") {
			continue
		}
		if !declared[lower] {
			t.Errorf("/validate set %q, which %s does not declare", name, wireFixturePath)
		}
	}
}
