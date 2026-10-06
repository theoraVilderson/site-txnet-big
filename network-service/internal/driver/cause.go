package driver

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"syscall"
)

// Cause is *why* a call failed, where FaultKind is what the loop does about
// it (ADR-0122). Four different things arrive as FaultUnavailable — a name
// that no longer resolves, a closed port, a host that never answers and a
// 502 — and the owner fixes each one somewhere else: the DNS record, the
// panel's port, the server, the panel itself. `network.PanelFaultCause`
// mirrors this set; the page translates each value.
type Cause string

const (
	// Network layer: nothing on the far side spoke. These alone can be our
	// own outage, and ADR-0122 point 3 is how that is ruled out.
	CauseDNSFailed         Cause = "dns_failed"
	CauseConnectionRefused Cause = "connection_refused"
	CauseUnreachable       Cause = "unreachable"
	CauseUnresponsive      Cause = "unresponsive"
	CauseTLSFailed         Cause = "tls_failed"

	// Answer layer: the panel spoke, so the cause is the panel's.
	CauseNotFound     Cause = "not_found"
	CauseServerError  Cause = "server_error"
	CauseLoginRefused Cause = "login_refused"
	CauseForbidden    Cause = "forbidden"
	CauseRateLimited  Cause = "rate_limited"
	CauseBadAnswer    Cause = "bad_answer"
)

// Causes is the closed set, in the enum's order.
var Causes = []Cause{
	CauseDNSFailed, CauseConnectionRefused, CauseUnreachable, CauseUnresponsive, CauseTLSFailed,
	CauseNotFound, CauseServerError, CauseLoginRefused, CauseForbidden, CauseRateLimited, CauseBadAnswer,
}

// NetworkLayer is true where nothing on the far side answered — the only
// causes our own egress or resolver could have produced.
func (c Cause) NetworkLayer() bool {
	switch c {
	case CauseDNSFailed, CauseConnectionRefused, CauseUnreachable, CauseUnresponsive, CauseTLSFailed:
		return true
	}
	return false
}

// CauseOf reads the cause out of a failed call: a driver's own where it set
// one (Fault.Cause), else what the transport error or the status says. An
// error no driver classified has none — it is ours, not the panel's.
//
// It is derived here rather than set by each driver because every family
// fails through the same net/http client: one reading of a DNS error or a
// refused dial, not thirteen.
func CauseOf(err error) Cause {
	if err == nil {
		return ""
	}
	var fault *Fault
	if !errors.As(err, &fault) {
		return ""
	}
	if fault.Cause != "" {
		return fault.Cause
	}
	if c := transportCause(fault.Err); c != "" {
		return c
	}
	switch {
	case fault.Status == http.StatusNotFound:
		return CauseNotFound
	case fault.Status == http.StatusUnauthorized:
		return CauseLoginRefused
	case fault.Status == http.StatusForbidden:
		return CauseForbidden
	case fault.Status == http.StatusTooManyRequests:
		return CauseRateLimited
	case fault.Status >= 500 && fault.Status != http.StatusNotImplemented && fault.Status != http.StatusGatewayTimeout:
		return CauseServerError
	}
	switch fault.Kind {
	case FaultTimeout:
		return CauseUnresponsive
	case FaultRateLimited:
		return CauseRateLimited
	case FaultBlocked:
		return CauseForbidden
	case FaultUnavailable:
		// A connection that failed in a way none of the above names.
		return CauseUnreachable
	default:
		return CauseBadAnswer
	}
}

// transportCause names a failure below HTTP. The order matters: a DNS
// failure and a refused connect are both inside a "dial" OpError, and the
// specific one wins over "the dial failed".
func transportCause(err error) Cause {
	if err == nil {
		return ""
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return CauseDNSFailed
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return CauseConnectionRefused
	}
	if errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) {
		return CauseUnreachable
	}
	var unknownCA x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var verify *tls.CertificateVerificationError
	var record tls.RecordHeaderError
	if errors.As(err, &unknownCA) || errors.As(err, &hostname) || errors.As(err, &invalid) ||
		errors.As(err, &verify) || errors.As(err, &record) {
		return CauseTLSFailed
	}
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		// Timed out or otherwise never connected: nothing answered.
		return CauseUnreachable
	}
	return ""
}
