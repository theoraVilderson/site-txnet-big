// Package privatecache is a Traefik middleware that keeps a response meant for
// one signed-in caller out of every shared cache (ADR-0129 decision 8,
// EDGE-1-j).
//
// A reseller may put its own CDN in front of its domain, and a CDN set to
// "cache everything" would otherwise store one user's `/api/me` and serve it
// to the next visitor. So when the request carried a credential — a bearer
// token or one of the platform's session cookies — or the response sets a
// cookie (a sign-in answers someone who sent none), and the service said
// nothing about caching, the response leaves as `Cache-Control: private,
// no-store`. A rule the service set itself is left alone: it knows its own
// response (Next's static assets are `public, immutable`).
//
// A CDN that ignores even this is caught by the domain check's cache probe
// (tenant contract.domains.md, EDGE-1-e), not here.
package privatecache

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
)

const privateNoStore = "private, no-store"

// sessionCookies: contracts/http/wire.json `cookies` (C-04); the test holds
// the two lists equal. A cookie that is not a credential (theme, locale) does
// not make a response private.
var sessionCookies = []string{"refresh_token", "device_id"}

// Config is empty: what counts as a credential is the contract's, not a
// deployment's.
type Config struct{}

// CreateConfig is Traefik's plugin entry point for the configuration.
func CreateConfig() *Config { return &Config{} }

type privateCache struct{ next http.Handler }

// New is Traefik's plugin entry point for the middleware.
func New(_ context.Context, next http.Handler, _ *Config, _ string) (http.Handler, error) {
	return &privateCache{next: next}, nil
}

func (p *privateCache) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	p.next.ServeHTTP(&writer{ResponseWriter: rw, credentialed: credentialed(req)}, req)
}

func credentialed(req *http.Request) bool {
	if strings.TrimSpace(req.Header.Get("Authorization")) != "" {
		return true
	}
	for _, name := range sessionCookies {
		if _, err := req.Cookie(name); err == nil {
			return true
		}
	}
	return false
}

// writer decides once, when the status line is about to leave.
type writer struct {
	http.ResponseWriter
	credentialed bool
	decided      bool
}

func (w *writer) mark(status int) {
	if w.decided {
		return
	}
	w.decided = true
	h := w.Header()
	if status == http.StatusSwitchingProtocols || h.Get("Cache-Control") != "" {
		return
	}
	if w.credentialed || len(h.Values("Set-Cookie")) > 0 {
		h.Set("Cache-Control", privateNoStore)
	}
}

func (w *writer) WriteHeader(status int) {
	w.mark(status)
	w.ResponseWriter.WriteHeader(status)
}

func (w *writer) Write(b []byte) (int, error) {
	w.mark(http.StatusOK)
	return w.ResponseWriter.Write(b)
}

// Flush keeps server-sent events streaming through this middleware.
func (w *writer) Flush() {
	w.mark(http.StatusOK)
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack keeps the realtime socket's upgrade working through this middleware.
func (w *writer) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hj, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("privatecache: %T cannot hijack", w.ResponseWriter)
	}
	w.decided = true
	return hj.Hijack()
}
