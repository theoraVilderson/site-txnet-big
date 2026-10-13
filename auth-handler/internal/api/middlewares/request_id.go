package middlewares

import (
	"crypto/rand"
	"fmt"
	"net/http"
	"regexp"

	"auth-handler/pkg/logger"
)

// HeaderRequestID is `requestHeaders.requestId` in contracts/http/wire.json
// (C-04). The gate answers with it on every response; Traefik copies it from a
// 2xx onto the upstream request (both `authResponseHeaders` lists), so every
// service behind the gate logs the id the gate logged (H13).
const HeaderRequestID = "X-Request-Id"

// acceptedRequestID is H13's rule, the same as shared-core's acceptRequestId:
// an id a log query can match and a log line cannot be broken by.
var acceptedRequestID = regexp.MustCompile(`^[A-Za-z0-9-]{8,128}$`)

// RequestID takes the caller's X-Request-Id when it fits H13, else mints a
// UUID v4, puts it on the request's context for the log lines (logger.WithRequestID)
// and on the response. Outermost in the chain, so every line names it.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(HeaderRequestID)
		if !acceptedRequestID.MatchString(id) {
			id = newRequestID()
		}
		w.Header().Set(HeaderRequestID, id)
		next.ServeHTTP(w, r.WithContext(logger.WithRequestID(r.Context(), id)))
	})
}

// newRequestID is a random UUID v4 (RFC 9562 §5.4).
func newRequestID() string {
	b := make([]byte, 16)
	// crypto/rand.Read never returns an error on the platforms Go supports.
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
