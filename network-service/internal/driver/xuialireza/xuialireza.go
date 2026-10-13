// Package xuialireza is the driver for x-ui panels of the alireza0 fork
// (F-027-bc), over the API the fork publishes under `/xui/API/inbounds`. The
// original x-ui (vaxilu) has no such API and is a family of its own,
// `x_ui_vaxilu` (user, 2026-09-24). 3x-ui was forked from this panel, so the
// driver is xuifamily's, shared with package sanaee; this package is where the
// fork is not Sanaee:
//
//   - an API request with no valid session is redirected to the login page,
//     so redirects are not followed: one is an expired session, answered by
//     one login and one retry. The request is not marked as the panel's ajax,
//     which would turn that redirect into a success=false no different from a
//     refusal. A 401 or a 404 from a proxy in front of it counts too.
//   - a client has no comment. x-ui stores the client map as it was sent and
//     builds Xray's config from a whitelist of its keys, so the claim tag is
//     written in a `comment` key it keeps but never reads. An operator who
//     saves the client in the panel's page drops it; the client then matches
//     by its other two keys (contract.drift.md).
//   - a client has no auto-renewal, so there is no `reset` to hold at 0, and
//     none is sent.
package xuialireza

import (
	"net/http"

	"network-service/internal/driver/xuifamily"
)

// Credentials is an x-ui panel login, read out of the owner's vault by
// internal/opener.
type Credentials = xuifamily.Credentials

// Driver is one x-ui panel (xuifamily.Driver).
type Driver = xuifamily.Driver

// dialect is the fork's API: everything under `/xui/API/inbounds`.
var dialect = xuifamily.Dialect{
	Family:          "xuialireza",
	Panel:           "x-ui",
	Inbounds:        []string{"xui", "API", "inbounds"},
	List:            []string{"xui", "API", "inbounds/"},
	Settings:        []string{"xui", "setting", "all"},
	ExpiryRedirects: true,
	LabelDetail:     "a comment key x-ui stores with the client but does not read; lost if the client is saved in the panel's page",
	CreditDetail:    "no credit and no auto-renewal of its own",
}

// New builds a driver over the panel at baseURL (xuifamily.New).
func New(baseURL, clientBaseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	return xuifamily.New(dialect, baseURL, clientBaseURL, creds, client)
}
