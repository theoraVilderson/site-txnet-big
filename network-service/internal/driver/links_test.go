package driver

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

const plainBody = "vless://a@h:443#x\n\n  trojan://b@h:8443#x  \nnot a link\nvmess://eyJ9\n"

var wantLines = []string{"vless://a@h:443#x", "trojan://b@h:8443#x", "vmess://eyJ9"}

// A subscription body is plain lines or their base64 (ADR-0082 rule 2): both
// read as the same lines, and anything that is not a link is dropped.
func TestParseLinksReadsPlainAndBase64Alike(t *testing.T) {
	if got := ParseLinks([]byte(plainBody)); !reflect.DeepEqual(got, wantLines) {
		t.Errorf("plain: %q, want %q", got, wantLines)
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(plainBody))
	if got := ParseLinks([]byte(encoded[:20] + "\n" + encoded[20:])); !reflect.DeepEqual(got, wantLines) {
		t.Errorf("base64: %q, want %q", got, wantLines)
	}
	if got := ParseLinks([]byte(base64.RawURLEncoding.EncodeToString([]byte(plainBody)))); !reflect.DeepEqual(got, wantLines) {
		t.Errorf("unpadded url-safe base64: %q, want %q", got, wantLines)
	}
	if got := ParseLinks([]byte("<html>login</html>")); got != nil {
		t.Errorf("a body with no link gave %q, want none", got)
	}
}

// The subscription is public: it is fetched with no credential of ours, and a
// failure is a Fault like any other call's (contract.links.md rule 3).
func TestFetchLinksIsCredentialFreeAndClassified(t *testing.T) {
	var auth, cookie string
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, cookie = r.Header.Get("Authorization"), r.Header.Get("Cookie")
		if status != http.StatusOK {
			w.Header().Set("Retry-After", "7")
			http.Error(w, "no", status)
			return
		}
		_, _ = w.Write([]byte(plainBody))
	}))
	t.Cleanup(srv.Close)

	got, err := FetchLinks(context.Background(), srv.Client(), "ClientLinks", srv.URL+"/sub/x")
	if err != nil || !reflect.DeepEqual(got, wantLines) {
		t.Fatalf("FetchLinks = %q, %v", got, err)
	}
	if auth != "" || cookie != "" {
		t.Errorf("the subscription read carried Authorization %q, Cookie %q", auth, cookie)
	}

	status = http.StatusTooManyRequests
	_, err = FetchLinks(context.Background(), srv.Client(), "ClientLinks", srv.URL+"/sub/x")
	var f *Fault
	if !IsRateLimited(err) || !errors.As(err, &f) || f.RetryAfter == 0 {
		t.Errorf("a 429 gave %v, want rate_limited with its Retry-After", err)
	}
	status = http.StatusBadGateway
	if _, err := FetchLinks(context.Background(), srv.Client(), "ClientLinks", srv.URL+"/sub/x"); !IsUnavailable(err) {
		t.Errorf("a 502 gave %v, want unavailable", err)
	}
}
