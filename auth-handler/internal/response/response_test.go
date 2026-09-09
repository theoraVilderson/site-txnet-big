package response

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// SafeExecute is the last line between an unexpected failure inside a handler
// and the wire. Two of its properties are load-bearing: a panic becomes a
// keyed error response rather than a dropped connection, and the panic's
// details never reach the client.

func TestOkAndErrShapes(t *testing.T) {
	okResp := Ok(map[string]string{"id": "1"}, "successful")
	if !okResp.OK || okResp.Msg != "successful" || okResp.Error != nil {
		t.Errorf("Ok() = %+v, want ok/successful with no error", okResp)
	}

	errResp := Err("forbidden", "details")
	if errResp.OK || errResp.Msg != "forbidden" || errResp.Data != nil {
		t.Errorf("Err() = %+v, want not-ok/forbidden with no data", errResp)
	}
}

// data and error are both omitempty, so a bare success does not put a null
// data field on the wire for clients to trip over.
func TestEnvelopeOmitsEmptyFields(t *testing.T) {
	raw, err := json.Marshal(Ok(nil, "successful"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(raw) != `{"ok":true,"msg":"successful"}` {
		t.Errorf("marshalled = %s, want no data/error keys", raw)
	}

	raw, err = json.Marshal(Err("unauthorized", nil))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(raw) != `{"ok":false,"msg":"unauthorized"}` {
		t.Errorf("marshalled = %s, want no data/error keys", raw)
	}
}

// A handler that already decided its own message key — every refusal in
// handlers.Validate does — must not have it overwritten with the success key.
func TestSafeExecutePassesAResponseThrough(t *testing.T) {
	want := Err("session_revoked", nil)
	got := SafeExecute(context.Background(), func() (interface{}, error) {
		return want, nil
	}, "successful", "failed")

	if got.OK || got.Msg != "session_revoked" {
		t.Errorf("SafeExecute() = %+v, want the handler's own response %+v", got, want)
	}
}

func TestSafeExecuteWrapsAPlainValue(t *testing.T) {
	got := SafeExecute(context.Background(), func() (interface{}, error) {
		return "payload", nil
	}, "successful", "failed")

	if !got.OK || got.Msg != "successful" || got.Data != "payload" {
		t.Errorf("SafeExecute() = %+v, want the value wrapped in an Ok", got)
	}
}

func TestSafeExecuteConvertsAnErrorToTheErrorKey(t *testing.T) {
	got := SafeExecute(context.Background(), func() (interface{}, error) {
		return nil, errors.New("redis: connection refused")
	}, "successful", "failed")

	if got.OK || got.Msg != "failed" {
		t.Errorf("SafeExecute() = %+v, want not-ok with the error key", got)
	}
	// The error text names a host, a driver, a wrapped path. It belongs in the
	// log, and the client gets the key alone — the rule `sanitizeError` follows
	// on the other side of this platform.
	if got.Error != nil {
		t.Errorf("Error = %v, want nothing: the error text must not reach the wire", got.Error)
	}
}

// A panic must produce a complete Response through the named return value,
// not the zero value — a zero Response marshals as ok:false with an empty
// msg, which statusForKey would map to 401 and no client could read.
func TestSafeExecuteRecoversFromAPanic(t *testing.T) {
	got := SafeExecute(context.Background(), func() (interface{}, error) {
		panic("nil map write")
	}, "successful", "failed")

	if got.OK {
		t.Errorf("SafeExecute() = %+v, want not-ok after a panic", got)
	}
	if got.Msg != "failed" {
		t.Errorf("Msg = %q, want the error key; an empty msg reaches the client as a blank message", got.Msg)
	}
	if got.Error != nil {
		t.Errorf("Error = %v, want nil; panic details must not reach the wire", got.Error)
	}
}

// A nil-pointer dereference panics with a runtime error rather than a string,
// and that path has to recover just the same.
func TestSafeExecuteRecoversFromARuntimePanic(t *testing.T) {
	got := SafeExecute(context.Background(), func() (interface{}, error) {
		var m map[string]string
		m["boom"] = "now" // assignment to entry in nil map
		return nil, nil
	}, "successful", "failed")

	if got.OK || got.Msg != "failed" {
		t.Errorf("SafeExecute() = %+v, want not-ok/failed", got)
	}
}

// An error takes precedence over any value returned alongside it, or a
// half-built payload would be served as a success.
func TestSafeExecutePrefersTheErrorOverTheValue(t *testing.T) {
	got := SafeExecute(context.Background(), func() (interface{}, error) {
		return Ok("half a payload", "successful"), errors.New("failed halfway")
	}, "successful", "failed")

	if got.OK {
		t.Errorf("SafeExecute() = %+v, want the error to win", got)
	}
}
