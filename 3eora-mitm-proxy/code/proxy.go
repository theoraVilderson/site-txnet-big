package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
)

type Proxy struct {
	ca           tls.Certificate
	cache        CacheStorage
	certs        *CertCache
	dedup        *Dedup
	noCacheHosts []string     // hostname patterns that always bypass the cache
	client       *http.Client // shared client for all origin fetches (built once in main, wired to SOCKS5 if configured)
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
		return
	}
	p.handleHTTP(w, r)
}

func (p *Proxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	hij, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack not supported", http.StatusInternalServerError)
		return
	}
	clientConn, _, err := hij.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer clientConn.Close()
	clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	host := r.URL.Hostname()
	if host == "" {
		host = r.Host
	}

	cert, err := p.certs.GetCert(host, &p.ca)
	if err != nil {
		log.Printf("cert generation failed for %s: %v", host, err)
		return
	}

	tlsCfg := &tls.Config{Certificates: []tls.Certificate{cert}}
	tlsClientConn := tls.Server(clientConn, tlsCfg)
	defer tlsClientConn.Close()

	connReader := bufio.NewReader(tlsClientConn)
	for {
		req, err := http.ReadRequest(connReader)
		if err != nil {
			break
		}
		req.URL.Scheme = "https"
		req.URL.Host = host
		req.RequestURI = ""

		resp := p.fetchOrCache(req)
		resp.Write(tlsClientConn)
		resp.Body.Close()
	}
}

func (p *Proxy) handleHTTP(w http.ResponseWriter, r *http.Request) {
	resp := p.fetchOrCache(r)
	defer resp.Body.Close()
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func (p *Proxy) fetchOrCache(req *http.Request) *http.Response {
	if !p.isCacheableRequest(req) {
		resp, err := p.fetchOrigin(req)
		if err != nil {
			return errorResponse()
		}
		return resp
	}

	key := cacheKey(req.Method, req.URL.String())
	ctx := req.Context()

	if cachedResp, ok := p.serveFromCache(ctx, key); ok {
		return cachedResp
	}

	// Only one in-flight fetch per key: whoever wins Start() does the real
	// fetch+upload; everyone else waits and then re-checks the cache.
	for {
		flight, isLeader := p.dedup.Start(key)
		if isLeader {
			break
		}
		if err := flight.Wait(ctx); err == nil {
			if cachedResp, ok := p.serveFromCache(ctx, key); ok {
				return cachedResp
			}
		}
		// Leader failed (origin error / non-200 / upload error) or ctx
		// expired: fall through and try to become the leader ourselves,
		// unless the context is already done.
		if ctx.Err() != nil {
			return errorResponse()
		}
	}

	resp, err := p.fetchOrigin(req)
	if err != nil {
		p.dedup.Finish(key, err)
		return errorResponse()
	}

	if resp.StatusCode != http.StatusOK {
		p.dedup.Finish(key, fmt.Errorf("status %d", resp.StatusCode))
		return resp
	}

	if !isCacheableResponse(resp) {
		p.dedup.Finish(key, fmt.Errorf("response marked non-cacheable"))
		return resp
	}

	pr, pw := io.Pipe()
	tee := &teeReadCloser{r: resp.Body, w: pw}
	resp.Body = tee

	go func() {
		err := p.cache.Put(context.Background(), key, resp.Header.Clone(), pr, req.Method, req.URL.String())
		pr.CloseWithError(err)
		if err != nil {
			log.Printf("cache upload error for %s: %v", key, err)
		}
		p.dedup.Finish(key, err)
	}()

	return resp
}

// isCacheableRequest reports whether this request should even be looked up
// in / written to the cache. POST/PUT/PATCH/DELETE etc. are never cached:
// they usually carry a body that isn't part of the cache key, and/or have
// side effects on the origin, so caching by method+URL alone would be wrong.
// Requests to hosts listed in noCacheHosts (e.g. your own private registry,
// which already has its own caching) also always bypass this cache.
func (p *Proxy) isCacheableRequest(req *http.Request) bool {
	switch req.Method {
	case http.MethodGet, http.MethodHead:
		// fall through to the host check below
	default:
		return false
	}

	host := req.URL.Hostname()
	for _, pattern := range p.noCacheHosts {
		if hostMatchesPattern(host, pattern) {
			return false
		}
	}
	return true
}

// hostMatchesPattern uses the same convention as NO_PROXY: a bare host like
// "registry.mycompany.local" matches that host and any subdomain of it; a
// pattern starting with "." matches only subdomains, not the bare host.
func hostMatchesPattern(host, pattern string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	if pattern == "" || host == "" {
		return false
	}
	if strings.HasPrefix(pattern, ".") {
		return strings.HasSuffix(host, pattern)
	}
	return host == pattern || strings.HasSuffix(host, "."+pattern)
}

// isCacheableResponse reports whether the origin's response is safe to
// store. We respect the origin's own Cache-Control signal: if it says the
// response is dynamic/per-request (no-store, no-cache, private) or sets a
// cookie, we pass it straight through without caching it.
func isCacheableResponse(resp *http.Response) bool {
	if resp.Header.Get("Set-Cookie") != "" {
		return false
	}
	cc := strings.ToLower(resp.Header.Get("Cache-Control"))
	if cc == "" {
		return true
	}
	for _, directive := range strings.Split(cc, ",") {
		switch strings.TrimSpace(directive) {
		case "no-store", "no-cache", "private":
			return false
		}
	}
	return true
}

func cacheKey(method, url string) string {
	h := sha256.Sum256([]byte(method + ":" + url))
	return fmt.Sprintf("%x", h)
}

func (p *Proxy) serveFromCache(ctx context.Context, key string) (*http.Response, bool) {
	headers, body, ok, err := p.cache.Get(ctx, key)
	if err != nil {
		log.Printf("cache read error for %s: %v", key, err)
		return nil, false
	}
	if !ok {
		return nil, false
	}

	// Extract status code from metadata
	statusCode := http.StatusOK
	if codeStr := headers.Get("X-Cache-Status-Code"); codeStr != "" {
		if code, err := strconv.Atoi(codeStr); err == nil && code > 0 {
			statusCode = code
		}
		headers.Del("X-Cache-Status-Code")
	}

	// Strip hop-by-hop headers that must not be forwarded from cache.
	hopByHop := []string{
		"Transfer-Encoding",
		"Connection",
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Te",
		"Trailer",
		"Upgrade",
	}
	for _, h := range hopByHop {
		headers.Del(h)
	}

	// Determine Content-Length from the header and set it on the struct field.
	contentLength := int64(-1)
	if cl := headers.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(cl, 10, 64); err == nil {
			contentLength = n
		}
		headers.Del("Content-Length")
	}

	resp := &http.Response{
		StatusCode:    statusCode,
		Header:        headers,
		Body:          body,
		ContentLength: contentLength,
	}
	normalizeResponse(resp)
	return resp, true
}

func (p *Proxy) fetchOrigin(req *http.Request) (*http.Response, error) {
	return p.client.Do(req)
}

func errorResponse() *http.Response {
	return &http.Response{
		StatusCode: http.StatusBadGateway,
		Body:       io.NopCloser(strings.NewReader("Bad Gateway")),
		Header:     make(http.Header),
	}
}

func copyHeaders(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

func normalizeResponse(resp *http.Response) {
	resp.Proto = "HTTP/1.1"
	resp.ProtoMajor = 1
	resp.ProtoMinor = 1
}