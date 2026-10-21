package source

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"network-service/internal/driver"
	"network-service/internal/egress"
)

// MaxBody is the most one answer from a source may carry: 32 MiB. A
// 20 000-client list is well under it; more is a panel answering something
// else, and the read fails rather than holding it (egress.ErrBodyTooLarge).
const MaxBody int64 = 32 << 20

// RequestTimeout bounds one request to a source, whatever the caller's
// deadline: a source that stalls is not waited on.
const RequestTimeout = 30 * time.Second

// ErrRedirect is a source that answered with a redirect. None is followed:
// the address read is the one the reseller typed (catalog §16).
var ErrRedirect = errors.New("source: redirect not followed")

// HTTPClient is the client a source is dialed through: g's guard and body cap,
// no redirect, each request bounded. A source is always a tenant's choice, so
// production passes the bare guard — never PANEL_EGRESS_ALLOW_CIDRS (ADR-0095).
func HTTPClient(g egress.Guard) *http.Client {
	if g.MaxBody <= 0 {
		g.MaxBody = MaxBody
	}
	hc := egress.Client(g)
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return ErrRedirect }
	hc.Timeout = RequestTimeout
	return hc
}

// Userinfo is a subscription's `Subscription-Userinfo` header: bytes up,
// down, the total allowed (0 = none given) and the end as unix seconds
// (0 = none).
type Userinfo struct {
	UploadBytes   int64 `json:"uploadBytes"`
	DownloadBytes int64 `json:"downloadBytes"`
	TotalBytes    int64 `json:"totalBytes"`
	ExpiresAt     int64 `json:"expiresAt"`
}

// ParseUserinfo reads `upload=…; download=…; total=…; expire=…`. A field
// missing or not a whole number reads 0; the admin enters what the header
// lacks (F-201-g).
func ParseUserinfo(header string) Userinfo {
	var u Userinfo
	for _, part := range strings.Split(header, ";") {
		key, value, _ := strings.Cut(strings.TrimSpace(part), "=")
		n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err != nil || n < 0 {
			continue
		}
		switch strings.ToLower(key) {
		case "upload":
			u.UploadBytes = n
		case "download":
			u.DownloadBytes = n
		case "total":
			u.TotalBytes = n
		case "expire":
			u.ExpiresAt = n
		}
	}
	return u
}

// Link is one old subscription link read whole: what F-201-g's single-user
// import is built from.
type Link struct {
	Userinfo Userinfo `json:"userinfo"`
	Lines    []string `json:"lines"`
}

// FetchLink reads one subscription URL — link mode. No credential is sent;
// the link is the user's own.
func FetchLink(ctx context.Context, hc *http.Client, url string) (Link, error) {
	sub, err := driver.FetchSubscription(ctx, hc, "FetchLink", url)
	if err != nil {
		return Link{}, err
	}
	return Link{Userinfo: ParseUserinfo(sub.Header.Get("Subscription-Userinfo")), Lines: sub.Lines}, nil
}
