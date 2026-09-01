package main

import (
	"context"
	"io"
	"net/http"
)

// CacheStorage is implemented by any cache backend. Today only S3Cache
// implements it; a future LocalCache (reading/writing an "images/" folder on
// disk) can be added later just by implementing the same two methods and
// wiring it into main.go — no changes needed to proxy.go.
type CacheStorage interface {
	// Get returns the cached response for key. ok=false means a clean cache
	// miss (not an error) and the caller should fetch from origin.
	Get(ctx context.Context, key string) (headers http.Header, body io.ReadCloser, ok bool, err error)

	// Put stores headers+body under key. method and url are the original
	// request's method and full URL — backends may use them purely for
	// bookkeeping (e.g. storing them as object metadata/tags so a cached
	// object can be identified by URL later), not as part of the cache
	// lookup itself (that's what key is for).
	Put(ctx context.Context, key string, headers http.Header, body io.Reader, method, url string) error
}