// Package response provides unified API response structures and helpers.
// All messages are i18n keys; translation is applied later by middleware.
package response

import (
	"context"
	"log/slog"
)

// Response is the standard API envelope returned by all handlers.
type Response struct {
	OK    bool        `json:"ok"`
	Msg   string      `json:"msg"`             // i18n key, translated later
	Data  interface{} `json:"data,omitempty"`  // success payload
	Error interface{} `json:"error,omitempty"` // error details
}

// Ok creates a success response with a message key.
func Ok(data interface{}, msgKey string) Response {
	return Response{
		OK:   true,
		Msg:  msgKey,
		Data: data,
	}
}

// Err creates an error response with a message key.
func Err(msgKey string, errObj interface{}) Response {
	return Response{
		OK:    false,
		Msg:   msgKey,
		Error: errObj,
	}
}

// SafeExecute runs a function and wraps its result or error into a Response.
// If the function returns a Response already, it is passed through unchanged.
// Otherwise, the returned value is wrapped in an Ok response.
// If the function returns an error or panics, an Err response keyed by
// errorMsgKey is returned; a panic is additionally logged (details are never
// put on the wire).
func SafeExecute(ctx context.Context, fn func() (interface{}, error), successMsgKey string, errorMsgKey string) (resp Response) {
	// Recover from panics and convert to an error response via the named
	// return value, so callers never see a zero Response.
	defer func() {
		if r := recover(); r != nil {
			slog.ErrorContext(ctx, "panic recovered in SafeExecute", "panic", r)
			resp = Err(errorMsgKey, nil)
		}
	}()

	result, err := fn()
	if err != nil {
		return Err(errorMsgKey, err.Error())
	}
	if r, ok := result.(Response); ok {
		return r
	}
	return Ok(result, successMsgKey)
}
