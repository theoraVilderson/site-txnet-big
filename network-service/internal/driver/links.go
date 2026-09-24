package driver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// maxSubscriptionBody bounds a subscription read. A user's lines are a few
// kilobytes; a megabyte is a panel answering with something else.
const maxSubscriptionBody = 1 << 20

// ParseLinks returns every link line in a subscription body, in the panel's
// order. The body is plain lines or their base64 — padded or not, standard or
// URL-safe, as the families variously serve it — and a line is a link when it
// has a scheme. Anything else (a comment, an HTML login page) is dropped, so a
// body with no link gives none.
func ParseLinks(body []byte) []string {
	text := string(body)
	if !strings.Contains(text, "://") {
		compact := strings.Map(func(r rune) rune {
			if unicode.IsSpace(r) {
				return -1
			}
			return r
		}, text)
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			if decoded, err := enc.DecodeString(compact); err == nil {
				text = string(decoded)
				break
			}
		}
	}
	var out []string
	lines := bufio.NewScanner(strings.NewReader(text))
	lines.Buffer(make([]byte, 64<<10), maxSubscriptionBody)
	for lines.Scan() {
		line := strings.TrimSpace(lines.Text())
		if scheme, _, ok := strings.Cut(line, "://"); ok && scheme != "" && !strings.ContainsAny(scheme, " <>\"") {
			out = append(out, line)
		}
	}
	return out
}

// FetchLinks reads a public subscription URL and returns its lines. It sends
// no credential of ours — the subscription is the user's, may sit on another
// host, and an admin token or a panel session sent there is the panel's whole
// admin power handed to whoever serves it (contract.links.md rule 3). A
// failure is classified here, as every call's is (fault.go).
func FetchLinks(ctx context.Context, hc *http.Client, op, url string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, NewFault(FaultProtocol, op, 0, err)
	}
	resp, err := hc.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, NewFault(FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return nil, NewFault(FaultUnavailable, op, 0, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		fault := FaultForStatus(op, resp.StatusCode,
			fmt.Errorf("the subscription answered %d: %s", resp.StatusCode, strings.TrimSpace(string(detail))))
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
			fault.RetryAfter = time.Duration(seconds) * time.Second
		}
		return nil, fault
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSubscriptionBody+1))
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, NewFault(FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return nil, NewFault(FaultUnavailable, op, 0, err)
	}
	if len(body) > maxSubscriptionBody {
		return nil, NewFault(FaultProtocol, op, 0, errors.New("the subscription body is over 1 MiB"))
	}
	return ParseLinks(bytes.TrimSpace(body)), nil
}
