// Package xuifamily is the one driver for the x-ui panels that share 3x-ui
// v2's API shape: `sanaee` (3x-ui by MHSanaei, F-027-ah) and `xuialireza`
// (the alireza0 fork, F-027-bc). The two were one file pasted twice (CS-1-i,
// C-27); what still differs between them is a Dialect, and each family's
// package is the Dialect plus its package doc. Pull, cumulative, and the panel
// enforces its own per-client traffic total, so it carries ADR-0072 as Marzban
// does.
//
// What every panel of the shape has, and the driver absorbs:
//
//   - the session is a cookie from a form login, and every reply is a
//     `{success, msg, obj}` envelope whose failures arrive as a 200 with
//     success=false. An expired session gets one login and one retry; how it
//     arrives is the Dialect's.
//   - a client lives inside its inbound: its settings are an element of the
//     inbound's `settings` JSON string, and its counters are a row of the
//     inbound's `clientStats`. The client's `email` is unique across the panel
//     and is the key of its counters, so it is our RemoteID.
//   - writing one field of a client means writing the whole client, sent to
//     the key the panel finds it by (the uuid, or a trojan client's password).
//     So every write reads the panel first.
//   - a `totalGB` of 0 (a byte figure, despite the name) is unlimited on the
//     panel, and a ceiling of zero is a cut-off here. Zero is written as one
//     byte.
package xuifamily

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"network-service/internal/driver"
)

// Dialect is what one family of the shape does its own way.
type Dialect struct {
	// Family names the driver in a constructor error: `sanaee`, `xuialireza`.
	Family string
	// Panel names the product in a refusal: `3x-ui`, `x-ui`.
	Panel string
	// Inbounds is the path of the client routes (addClient, updateClient, …).
	Inbounds []string
	// List is the path of the inbound list, every client's counters in it.
	List []string
	// Settings is the path of the panel's settings, the sub server's in it.
	Settings []string
	// ExpiryRedirects: an expired session is a redirect to the login page, so
	// redirects are not followed and a request is not marked as the panel's
	// ajax, which would turn the redirect into a success=false no different
	// from a refusal. Otherwise the request is marked, and an expired session
	// is a 401 or a 404.
	ExpiryRedirects bool
	// HoldsReset: the client has an auto-renewal `reset`, which zeroes its
	// counter every that many days. Every write sets 0, so we stay the only
	// writer of the quota.
	HoldsReset bool
	// LabelDetail and CreditDetail answer RowClientLabelStorable and
	// RowInternalCreditDisabled, the two rows whose reason differs.
	LabelDetail  string
	CreditDetail string
}

// expired is a status an expired session can arrive as (Dialect.ExpiryRedirects).
func (dl Dialect) expired(status int) bool {
	if status == http.StatusUnauthorized || status == http.StatusNotFound {
		return true
	}
	return dl.ExpiryRedirects && status >= 300 && status < 400
}

// Credentials is a panel login, read out of the owner's vault by
// internal/opener.
type Credentials struct {
	Username string
	Password string
}

// Driver is one panel. It is safe for concurrent use; driver.Pace is what
// keeps concurrent use from becoming a flood.
type Driver struct {
	// BulkUsage is GetUsage and GetUsageFor, over usage's one read.
	driver.BulkUsage
	dialect Dialect
	base    *url.URL
	creds   Credentials
	http    *http.Client
	// served is where users connect when an inbound listens on every
	// address: the panel's clientBaseUrl, else base (ADR-0088).
	served *url.URL

	mu      sync.Mutex
	cookies []*http.Cookie
	// refusals is held under mu: login counts the panel's refusals.
	refusals driver.LoginRefusals
}

var _ driver.Driver = (*Driver)(nil)

// protocols are the inbound protocols this driver provisions clients on.
// Shadowsocks is not one: a 2022 cipher's client key is a base64 key of the
// cipher's length, and the config's uuid is not one.
var protocols = []string{"vless", "vmess", "trojan"}

// New builds a driver over the panel at baseURL, which includes the panel's
// web base path when it has one. clientBaseURL, when set, is the host users
// connect to on an inbound that listens on every address (ADR-0088). Nothing
// is sent until the first call.
func New(dialect Dialect, baseURL, clientBaseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("%s: base url %q is not an absolute url", dialect.Family, baseURL)
	}
	served := base
	if strings.TrimSpace(clientBaseURL) != "" {
		u, err := url.Parse(strings.TrimRight(strings.TrimSpace(clientBaseURL), "/"))
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("%s: client base url %q is not an absolute url", dialect.Family, clientBaseURL)
		}
		served = u
	}
	// No client timeout: the caller's context is the deadline (driver.Driver).
	own := http.Client{}
	if client != nil {
		own = *client
	}
	if dialect.ExpiryRedirects {
		// Following the redirect would read the login page as the answer.
		own.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	}
	d := &Driver{dialect: dialect, base: base, creds: creds, http: &own, served: served}
	d.BulkUsage = d.usage
	return d, nil
}

// inbounds is a client route under the dialect's inbounds path.
func (d *Driver) inbounds(tail ...string) []string {
	return append(append([]string{}, d.dialect.Inbounds...), tail...)
}
