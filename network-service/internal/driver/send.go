package driver

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Send is one request to a panel with its failures classified (Fault): a
// transport error after the deadline is a timeout, any other one unavailable,
// and a status of 300 or more is FaultForStatus's, carrying the panel's
// Retry-After. A success is the caller's to read and close. The families
// written before it classify the same way inline; a new one calls this (C-27).
func Send(ctx context.Context, hc *http.Client, op string, req *http.Request) (*http.Response, error) {
	resp, err := hc.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, NewFault(FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return nil, NewFault(FaultUnavailable, op, 0, err)
	}
	if resp.StatusCode < 300 {
		return resp, nil
	}
	defer resp.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	fault := FaultForStatus(op, resp.StatusCode, fmt.Errorf("%s", strings.TrimSpace(string(detail))))
	if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
		fault.RetryAfter = time.Duration(seconds) * time.Second
	}
	return nil, fault
}
