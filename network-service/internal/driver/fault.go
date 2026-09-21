package driver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// Why a call failed, as six kinds (F-027-j).
//
// The distinction that pays for this file is 429 against 5xx. They arrive as
// the same "the call did not work" and mean opposite things: a 429 is a
// healthy panel asking for a slower caller, and a 5xx is a panel that is
// failing. Conflating them either quarantines a panel we were rude to, or
// keeps hammering one that is down — and F-027-v's per-panel request budget is
// written on the difference.
//
// A driver classifies; nothing above it reads a status code. That is the same
// rule as the rest of this package: a family's quirk becomes a declared kind
// here, or it does not reach the loop at all.

// FaultKind is the closed set. A kind exists only where something above the
// driver does a different thing with it.
type FaultKind string

const (
	// FaultTimeout: our own deadline passed. The panel is not implicated —
	// the loop's budget is per panel, and a call that outlives it is cut off
	// rather than allowed to spend another panel's turn.
	FaultTimeout FaultKind = "timeout"
	// FaultRateLimited: 429. The panel works and wants to be asked less.
	// Retrying sooner makes it worse; the remedy is the request budget.
	FaultRateLimited FaultKind = "rate_limited"
	// FaultBlocked: 401 or 403. Our credentials or our address are being
	// refused. Retrying is the behaviour that gets the address banned, so this
	// is never retried and reaches the owner instead (F-027-v).
	FaultBlocked FaultKind = "blocked"
	// FaultUnavailable: 5xx, or a connection that never got an answer. The
	// panel is down. The pass fails, the cursor is untouched, and nothing is
	// billed from a reading that does not exist.
	FaultUnavailable FaultKind = "unavailable"
	// FaultUnsupported: the family cannot do this at all. Retrying never
	// helps, and the answer belongs in the questionnaire rather than in an
	// error — this is what a panel returns when asked anyway.
	FaultUnsupported FaultKind = "unsupported"
	// FaultProtocol: the panel answered and the answer was not one we can
	// act on. A missing client is not this: its verdict comes from the drift
	// comparison, which has our side of the story too (F-027-aa).
	FaultProtocol FaultKind = "protocol"
)

// Fault is every error a Driver returns. A driver that returns a bare error
// has told the loop nothing it can act on, and the conformance suite refuses
// one (F-027-j).
type Fault struct {
	Kind FaultKind
	// Op is the Driver method, for the log line and the panel's health page.
	Op string
	// Status is the HTTP status where there was one, and 0 otherwise.
	Status int
	// RetryAfter is the panel's own answer to "when", where it gave one.
	RetryAfter time.Duration
	// Err is what actually happened, kept so a caller can unwrap to
	// context.DeadlineExceeded or a transport error.
	Err error
}

func (f *Fault) Error() string {
	msg := fmt.Sprintf("%s: %s", f.Op, f.Kind)
	if f.Status != 0 {
		msg += fmt.Sprintf(" (http %d)", f.Status)
	}
	if f.Err != nil {
		msg += ": " + f.Err.Error()
	}
	return msg
}

func (f *Fault) Unwrap() error { return f.Err }

// NewFault builds one. Drivers use it for everything a status code does not
// already describe: a stalled dial, an unparsable body, a method the family
// does not have.
func NewFault(kind FaultKind, op string, status int, err error) *Fault {
	return &Fault{Kind: kind, Op: op, Status: status, Err: err}
}

// FaultForStatus classifies an HTTP reply. It is the one place a status code
// turns into behaviour, so a family that means something unusual by a status
// overrides it in its own driver rather than teaching this function a quirk.
func FaultForStatus(op string, status int, err error) *Fault {
	kind := FaultProtocol
	switch {
	case status == http.StatusRequestTimeout || status == http.StatusGatewayTimeout:
		kind = FaultTimeout
	case status == http.StatusTooManyRequests:
		kind = FaultRateLimited
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		kind = FaultBlocked
	case status == http.StatusNotImplemented || status == http.StatusMethodNotAllowed:
		kind = FaultUnsupported
	case status >= 500:
		kind = FaultUnavailable
	}
	return &Fault{Kind: kind, Op: op, Status: status, Err: err}
}

// KindOf reads a fault's kind out of a wrapped error. The second result is
// false for an error no driver classified.
func KindOf(err error) (FaultKind, bool) {
	var fault *Fault
	if errors.As(err, &fault) {
		return fault.Kind, true
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return FaultTimeout, true
	}
	return "", false
}

func isKind(err error, kind FaultKind) bool {
	got, ok := KindOf(err)
	return ok && got == kind
}

// IsTimeout reports our own deadline passing, not the panel's failure.
func IsTimeout(err error) bool { return isKind(err, FaultTimeout) }

// IsRateLimited reports a 429: the panel is healthy and wants a slower caller.
func IsRateLimited(err error) bool { return isKind(err, FaultRateLimited) }

// IsBlocked reports a 401 or 403: refused, never retried, told to the owner.
func IsBlocked(err error) bool { return isKind(err, FaultBlocked) }

// IsUnavailable reports a 5xx or a connection that failed: the panel is down.
func IsUnavailable(err error) bool { return isKind(err, FaultUnavailable) }

// IsUnsupported reports a call the family cannot serve at all.
func IsUnsupported(err error) bool { return isKind(err, FaultUnsupported) }

// IsThrottledOrBlocked is F-027-v's bucket: the panel is not down, it is
// refusing us. It gets no retry and an alert to the owner, where `down` gets
// the next pass.
func IsThrottledOrBlocked(err error) bool {
	return IsRateLimited(err) || IsBlocked(err)
}
