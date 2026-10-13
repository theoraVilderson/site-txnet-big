// Package sanaee is the driver for 3x-ui v2 panels by MHSanaei (F-027-ah), the
// family known as "Sanaee". The driver itself is xuifamily's, shared with the
// alireza0 fork; this package is what 3x-ui does its own way:
//
//   - a request with no valid session is a 404 on v2 (the API hides itself)
//     and a 401 on older versions; it is marked as the panel's ajax so that
//     neither is a redirect to the login page.
//   - a client's `reset` other than 0 zeroes its counter every that many days.
//     Every write sets 0, so we stay the only writer of the quota.
//   - the claim tag is the client's own `comment` field.
package sanaee

import (
	"net/http"

	"network-service/internal/driver/xuifamily"
)

// Credentials is a 3x-ui panel login, read out of the owner's vault by
// internal/opener.
type Credentials = xuifamily.Credentials

// Driver is one 3x-ui panel (xuifamily.Driver).
type Driver = xuifamily.Driver

// dialect is 3x-ui v2's API: everything under `/panel/api/inbounds`.
var dialect = xuifamily.Dialect{
	Family:       "sanaee",
	Panel:        "3x-ui",
	Inbounds:     []string{"panel", "api", "inbounds"},
	List:         []string{"panel", "api", "inbounds", "list"},
	Settings:     []string{"panel", "setting", "all"},
	HoldsReset:   true,
	LabelDetail:  "the comment field",
	CreditDetail: "no credit of its own; the client's reset is written 0 on every write",
}

// New builds a driver over the panel at baseURL (xuifamily.New).
func New(baseURL, clientBaseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	return xuifamily.New(dialect, baseURL, clientBaseURL, creds, client)
}
