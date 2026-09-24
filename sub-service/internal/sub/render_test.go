package sub

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The invariant this row turns on (F-113-b, catalog §7.5, ADR-0082 rule 3):
// the body is every stored line of the Grant's configs that a client app can
// actually use — a live config, captured from the client it is now, on a panel
// still serving users — in one base64 URI list. Nothing else in the store
// reaches it; the other formats are built from the same lines (formats_test.go).

func live(panelState, uuid string, lines ...string) Config {
	return Config{PanelState: panelState, Status: "active", DesiredRemote: "present",
		UUID: uuid, LinksUUID: uuid, LinkLines: lines}
}

func storeWith(configs ...Config) *fakeStore {
	s := newStore()
	s.configs = map[string][]Config{"g-1": configs}
	return s
}

func get(t *testing.T, store Store, path, ua string) *http.Response {
	t.Helper()
	mux := http.NewServeMux()
	New(store, discard()).Register(mux)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "sub.alpha.com"
	if ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec.Result()
}

func decoded(t *testing.T, res *http.Response) []string {
	t.Helper()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	raw, _ := io.ReadAll(res.Body)
	if len(raw) == 0 {
		return nil
	}
	plain, err := base64.StdEncoding.DecodeString(string(raw))
	if err != nil {
		t.Fatalf("body %q is not standard base64: %v", raw, err)
	}
	return strings.Split(string(plain), "\n")
}

func TestBodyIsEveryServedLineInOrderAsBase64(t *testing.T) {
	store := storeWith(
		live("healthy", "u1", "vless://a", "vmess://b"),
		live("healthy", "u2", "trojan://c"),
	)
	got := decoded(t, get(t, store, "/sub/"+token, "v2rayNG/1.8.5"))
	want := []string{"vless://a", "vmess://b", "trojan://c"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("lines = %q, want %q (configs in the store's order, each panel's lines in its order)", got, want)
	}
}

func TestOnlyPanelsStillServingUsersContribute(t *testing.T) {
	cases := []struct {
		state  string
		served bool
	}{
		{"healthy", true},
		// A panel that answered in a shape we cannot act on, or that refused
		// our admin calls, is still serving its users (contract.budget.md).
		{"degraded", true},
		{"throttled_or_blocked", true},
		{"down", false},
		{"maintenance", false},
		{"a-state-added-later", false},
	}
	for _, tc := range cases {
		t.Run(tc.state, func(t *testing.T) {
			got := decoded(t, get(t, storeWith(live(tc.state, "u1", "vless://x")), "/sub/"+token, ""))
			if (len(got) == 1) != tc.served {
				t.Fatalf("panelState %s: lines = %q, served = %v", tc.state, got, tc.served)
			}
		})
	}
}

func TestOnlyALiveConfigCapturedFromItsCurrentClientContributes(t *testing.T) {
	frozen := live("healthy", "u1", "vless://frozen")
	frozen.Status = "frozen"
	retired := live("healthy", "u2", "vless://retired")
	retired.Status, retired.DesiredRemote = "retired", "absent"
	absent := live("healthy", "u3", "vless://absent")
	absent.DesiredRemote = "absent"
	regenerated := live("healthy", "u4-new", "vless://old-uuid")
	regenerated.LinksUUID = "u4-old"
	neverCaptured := live("healthy", "u5")
	neverCaptured.LinksUUID = ""

	store := storeWith(frozen, retired, absent, regenerated, neverCaptured, live("healthy", "u6", "vless://ok"))
	got := decoded(t, get(t, store, "/sub/"+token, ""))
	if len(got) != 1 || got[0] != "vless://ok" {
		t.Fatalf("lines = %q, want only the live, freshly captured config's", got)
	}
}

func TestNothingToServeIsAnEmptyValidBody(t *testing.T) {
	res := get(t, storeWith(live("down", "u1", "vless://x")), "/sub/"+token, "")
	if got := decoded(t, res); got != nil {
		t.Fatalf("lines = %q, want an empty body", got)
	}
}

func TestFormatComesFromTheOverrideThenTheUserAgent(t *testing.T) {
	cases := []struct {
		query, ua string
		want      Format
	}{
		{"", "", FormatBase64},
		{"", "SomeUnknownApp/2.0", FormatBase64},
		{"", "v2rayNG/1.8.5", FormatBase64},
		{"", "clash-verge/v1.3.8", FormatClash},
		{"", "mihomo/1.18", FormatClash},
		{"", "SFA/1.9.0 (sing-box 1.9.0)", FormatSingBox},
		{"format=base64", "clash-verge/v1.3.8", FormatBase64},
		{"format=CLASH", "v2rayNG/1.8.5", FormatClash},
		{"format=sing-box", "", FormatSingBox},
		{"format=xray", "", FormatXray},
		{"format=nonsense", "clash-verge/v1.3.8", FormatClash},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet, "/sub/t?"+tc.query, nil)
		req.Header.Set("User-Agent", tc.ua)
		if got := DetectFormat(req); got != tc.want {
			t.Errorf("?%s UA %q: format = %s, want %s", tc.query, tc.ua, got, tc.want)
		}
	}
}

func TestConfigReadFailureIs503(t *testing.T) {
	store := storeWith(live("healthy", "u1", "vless://a"))
	store.configErr = errString("connection reset")
	if res := get(t, store, "/sub/"+token, ""); res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: an empty body would wipe the app's servers", res.StatusCode)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
