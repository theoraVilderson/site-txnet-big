package privatecache

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// serve runs one request through the middleware; the service answers with
// the headers `set` and a 200.
func serve(t *testing.T, req *http.Request, set http.Header) *httptest.ResponseRecorder {
	t.Helper()
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		for k, v := range set {
			w.Header()[k] = v
		}
		_, _ = w.Write([]byte("{}"))
	})
	h, err := New(context.Background(), next, CreateConfig(), "private-cache")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func get() *http.Request { return httptest.NewRequest(http.MethodGet, "https://shop.example.test/api/me", nil) }

func TestABearerCallersResponseIsPrivate(t *testing.T) {
	req := get()
	req.Header.Set("Authorization", "Bearer x.y.z")
	if got := serve(t, req, nil).Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
}

func TestASessionCookieMakesItPrivate(t *testing.T) {
	for _, name := range []string{"refresh_token", "device_id"} {
		req := get()
		req.Header.Set("Cookie", "theme=dark; "+name+"=abc")
		if got := serve(t, req, nil).Header().Get("Cache-Control"); got != "private, no-store" {
			t.Fatalf("cookie %s: Cache-Control = %q, want private, no-store", name, got)
		}
	}
}

// A sign-in answers a caller who sent no credential, and sets one.
func TestAResponseThatSetsACookieIsPrivate(t *testing.T) {
	got := serve(t, get(), http.Header{"Set-Cookie": {"refresh_token=abc; HttpOnly"}}).Header().Get("Cache-Control")
	if got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
}

func TestTheServicesOwnRuleWins(t *testing.T) {
	req := get()
	req.Header.Set("Authorization", "Bearer x.y.z")
	rule := "public, max-age=31536000, immutable"
	if got := serve(t, req, http.Header{"Cache-Control": {rule}}).Header().Get("Cache-Control"); got != rule {
		t.Fatalf("Cache-Control = %q, want the service's %q", got, rule)
	}
}

func TestAnAnonymousResponseIsLeftAlone(t *testing.T) {
	req := get()
	req.Header.Set("Cookie", "theme=dark; locale=fa")
	if got := serve(t, req, nil).Header().Get("Cache-Control"); got != "" {
		t.Fatalf("anonymous: Cache-Control = %q, want none", got)
	}
}

// Nothing written but a status still passes through WriteHeader.
func TestAnEmptyBodyIsMarkedToo(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h, _ := New(context.Background(), next, CreateConfig(), "private-cache")
	req := get()
	req.Header.Set("Authorization", "Bearer x.y.z")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
}

type hijackable struct {
	*httptest.ResponseRecorder
	hijacked bool
}

func (h *hijackable) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.hijacked = true
	return nil, nil, nil
}

// The realtime socket upgrades through this middleware, and SSE flushes.
func TestTheWriterStillHijacksAndFlushes(t *testing.T) {
	var canHijack, canFlush bool
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, canFlush = w.(http.Flusher)
		if hj, ok := w.(http.Hijacker); ok {
			canHijack = true
			_, _, _ = hj.Hijack()
		}
	})
	h, _ := New(context.Background(), next, CreateConfig(), "private-cache")
	w := &hijackable{ResponseRecorder: httptest.NewRecorder()}
	h.ServeHTTP(w, get())
	if !canHijack || !w.hijacked || !canFlush {
		t.Fatalf("hijack=%v (reached %v) flush=%v", canHijack, w.hijacked, canFlush)
	}
}

// The cookie names are the ones contracts/http/wire.json declares (C-04).
func TestTheCookiesAreTheContractsCookies(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "..", "..", "contracts", "http", "wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Cookies map[string]string `json:"cookies"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for k, v := range wire.Cookies {
		if k != "note" {
			want[v] = true
		}
	}
	got := map[string]bool{}
	for _, c := range sessionCookies {
		got[c] = true
	}
	if len(got) != len(want) {
		t.Fatalf("sessionCookies %v, wire.json cookies %v", sessionCookies, want)
	}
	for c := range want {
		if !got[c] {
			t.Fatalf("wire.json cookie %q missing from sessionCookies %v", c, sessionCookies)
		}
	}
}
