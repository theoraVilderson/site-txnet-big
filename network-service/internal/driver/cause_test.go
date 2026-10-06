package driver_test

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"syscall"
	"testing"

	"network-service/internal/driver"
)

// ADR-0122: an owner is told what to fix — a DNS record, a port, a login —
// and that is only possible if a failure keeps its cause. These are the
// shapes Go's HTTP client actually returns, wrapped the way drivers wrap them.
func TestCauseOfNamesWhatTheOwnerHasToFix(t *testing.T) {
	dial := func(err error) error {
		return driver.NewFault(driver.FaultUnavailable, "GetUsage", 0,
			fmt.Errorf("Post \"http://panel/login\": %w", &net.OpError{Op: "dial", Net: "tcp", Err: err}))
	}
	logins := &driver.LoginRefusals{}
	logins.Succeeded()

	for _, tc := range []struct {
		name string
		err  error
		want driver.Cause
	}{
		{"a name that no longer resolves", dial(&net.DNSError{Err: "no such host", Name: "panel.example.com", IsNotFound: true}), driver.CauseDNSFailed},
		{"a closed or moved port", dial(os.NewSyscallError("connect", syscall.ECONNREFUSED)), driver.CauseConnectionRefused},
		{"no route to the host", dial(os.NewSyscallError("connect", syscall.EHOSTUNREACH)), driver.CauseUnreachable},
		{"a dial that never got an answer", dial(timeoutError{}), driver.CauseUnreachable},
		{"our deadline on a connected panel", driver.NewFault(driver.FaultTimeout, "GetUsage", 0, context.DeadlineExceeded), driver.CauseUnresponsive},
		{"a certificate we cannot trust", driver.NewFault(driver.FaultUnavailable, "GetUsage", 0, fmt.Errorf("tls: %w", x509.UnknownAuthorityError{})), driver.CauseTLSFailed},
		{"a path that moved", driver.FaultForStatus("GetUsage", http.StatusNotFound, nil), driver.CauseNotFound},
		{"the panel's own failure", driver.FaultForStatus("GetUsage", http.StatusBadGateway, nil), driver.CauseServerError},
		{"a 401 is the login", driver.FaultForStatus("GetUsage", http.StatusUnauthorized, nil), driver.CauseLoginRefused},
		{"a 403 is our address", driver.FaultForStatus("GetUsage", http.StatusForbidden, nil), driver.CauseForbidden},
		{"a 429", driver.FaultForStatus("GetUsage", http.StatusTooManyRequests, nil), driver.CauseRateLimited},
		{"an answer we cannot read", driver.FaultForStatus("GetUsage", http.StatusTeapot, nil), driver.CauseBadAnswer},
		// A refused login is still `unavailable` on its first refusals (it may be a
		// locked SQLite), but what it is about is the login, and the owner is told so.
		{"a refused login that once worked", logins.Refused("GetUsage", http.StatusOK, "wrong username or password"), driver.CauseLoginRefused},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := driver.CauseOf(tc.err); got != tc.want {
				t.Fatalf("cause = %q, want %q (err: %v)", got, tc.want, tc.err)
			}
		})
	}
}

// The same, through a real dial rather than a constructed error: the shape
// that reached dev on 2026-10-06 when a panel's port moved.
func TestCauseOfARealRefusedDial(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	_, dialErr := http.Post("http://"+addr+"/secret/login", "application/json", nil)
	if dialErr == nil {
		t.Fatal("a closed port answered")
	}
	fault := driver.NewFault(driver.FaultUnavailable, "GetUsage", 0, dialErr)
	if got := driver.CauseOf(fault); got != driver.CauseConnectionRefused {
		t.Fatalf("cause = %q, want %q (err: %v)", got, driver.CauseConnectionRefused, dialErr)
	}
}

// Anything no driver classified has no cause: it is ours, not the panel's.
func TestCauseOfAnUnclassifiedErrorIsNone(t *testing.T) {
	if got := driver.CauseOf(errors.New("broker refused the publish")); got != "" {
		t.Fatalf("cause = %q for an error no driver classified", got)
	}
	if got := driver.CauseOf(nil); got != "" {
		t.Fatalf("cause = %q for no error", got)
	}
}

// Every cause is network or answer layer, and only the network layer can be
// our own outage (ADR-0122 point 2).
func TestCauseLayers(t *testing.T) {
	network := map[driver.Cause]bool{
		driver.CauseDNSFailed: true, driver.CauseConnectionRefused: true, driver.CauseUnreachable: true,
		driver.CauseUnresponsive: true, driver.CauseTLSFailed: true,
	}
	for _, c := range driver.Causes {
		if c.NetworkLayer() != network[c] {
			t.Errorf("%q: NetworkLayer() = %v", c, c.NetworkLayer())
		}
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
