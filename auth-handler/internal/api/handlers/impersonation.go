package handlers

import (
	"path"
	"strings"
)

// impersonationRoute is one row of `contracts/http/impersonation.json`.
type impersonationRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Socket bool   `json:"socket,omitempty"`
}

// impersonationReach is every route an impersonated token may reach (AC-1-g,
// ADR-0136, catalog §3.6 layer 4) — an allowlist, so a route nobody listed is
// closed. A copy of the fixture, pinned to it by
// TestContractImpersonationReachIsTheFixture; edit the fixture first. The
// `/api/auth` rows are auth-service's, which is not behind this gate and
// holds the same list itself (shared-core `http/impersonation.ts`).
var impersonationReach = []impersonationRoute{
	{Method: "GET", Path: "/api/auth/me"},
	{Method: "GET", Path: "/api/auth/me/messenger"},
	{Method: "GET", Path: "/api/auth/me/timezone"},
	{Method: "PUT", Path: "/api/auth/me/timezone"},
	{Method: "PUT", Path: "/api/auth/me/name"},
	{Method: "GET", Path: "/api/auth/me/ui-preferences"},
	{Method: "PATCH", Path: "/api/auth/me/ui-preferences"},
	{Method: "POST", Path: "/api/auth/impersonate/end"},
	{Method: "GET", Path: "/api/ai/me/suggestion"},
	{Method: "POST", Path: "/api/ai/me/suggestion/:actionId/dismiss"},
	{Method: "POST", Path: "/api/ai/me/suggestion/:actionId/opt-out"},
	{Method: "GET", Path: "/api/billing/offers"},
	{Method: "POST", Path: "/api/billing/invoices"},
	{Method: "GET", Path: "/api/billing/invoices/:id"},
	{Method: "POST", Path: "/api/billing/invoices/:id/pay"},
	{Method: "POST", Path: "/api/billing/invoices/:id/cancel"},
	{Method: "GET", Path: "/api/billing/deposit/gateways"},
	{Method: "POST", Path: "/api/billing/deposit/quote"},
	{Method: "POST", Path: "/api/billing/deposit/start"},
	{Method: "POST", Path: "/api/billing/deposit/:paymentId/abandon"},
	{Method: "POST", Path: "/api/billing/gift/redeem"},
	{Method: "GET", Path: "/api/billing/gift/grants"},
	{Method: "PUT", Path: "/api/billing/gift/grants/:grantId/label"},
	{Method: "GET", Path: "/api/billing/traffic/grants/:grantId/usage"},
	{Method: "GET", Path: "/api/billing/traffic/grants/:grantId/period"},
	{Method: "PUT", Path: "/api/billing/traffic/configs/:configId/label"},
	{Method: "GET", Path: "/api/billing/traffic/grants/:grantId/cap"},
	{Method: "PUT", Path: "/api/billing/traffic/grants/:grantId/cap"},
	{Method: "DELETE", Path: "/api/billing/traffic/grants/:grantId/cap"},
	{Method: "GET", Path: "/api/billing/wallet/history"},
	{Method: "GET", Path: "/api/billing/wallet/payments"},
	{Method: "GET", Path: "/api/billing/wallet/payments/:id"},
	{Method: "GET", Path: "/api/billing/lotteries"},
	{Method: "GET", Path: "/api/billing/lotteries/:id/result"},
	{Method: "POST", Path: "/api/billing/lotteries/:id/entry"},
	{Method: "DELETE", Path: "/api/billing/lotteries/:id/entry"},
	{Method: "GET", Path: "/api/billing/wheel"},
	{Method: "GET", Path: "/api/billing/wheel/history"},
	{Method: "POST", Path: "/api/billing/wheel/spin"},
	{Method: "GET", Path: "/api/currency/rates"},
	{Method: "GET", Path: "/api/notifications"},
	{Method: "POST", Path: "/api/notifications/read"},
	{Method: "GET", Path: "/api/notifications/preferences"},
	{Method: "PUT", Path: "/api/notifications/preferences"},
	{Method: "GET", Path: "/api/notifications/preferences/grants"},
	{Method: "PUT", Path: "/api/notifications/preferences/grants/:grantId"},
	{Method: "GET", Path: "/api/support/categories"},
	{Method: "GET", Path: "/api/support/availability"},
	{Method: "GET", Path: "/api/support/conversations"},
	{Method: "POST", Path: "/api/support/conversations"},
	{Method: "GET", Path: "/api/support/conversations/counts"},
	{Method: "GET", Path: "/api/support/conversations/:id/messages"},
	{Method: "POST", Path: "/api/support/conversations/:id/messages"},
	{Method: "POST", Path: "/api/support/conversations/:id/attachments"},
	{Method: "GET", Path: "/api/support/conversations/:id/attachments/:attachmentId"},
	{Method: "POST", Path: "/api/support/conversations/:id/typing"},
	{Method: "POST", Path: "/api/support/conversations/:id/read"},
	{Method: "POST", Path: "/api/support/conversations/:id/rating"},
	{Method: "POST", Path: "/api/support/conversations/:id/reopen"},
	{Method: "GET", Path: "/api/tenants/purchase/packages"},
	{Method: "GET", Path: "/api/tenants/purchase/mine"},
	{Method: "GET", Path: "/api/tenants/purchase/slug"},
	{Method: "GET", Path: "/api/guides/feedback/:key"},
	{Method: "PUT", Path: "/api/guides/feedback/:key"},
	{Method: "GET", Path: "/realtime", Socket: true},
}

// reasonImpersonationBlocked: the route is not on the impersonation list.
// Refreshing will not change it; the panel says the action is not available
// while signed in as someone else.
const reasonImpersonationBlocked = "impersonationBlocked"

// impersonationMayReach reports whether an impersonated token may make the
// request Traefik asks about (X-Forwarded-Method, X-Forwarded-Uri). A `:name`
// segment matches any one non-empty segment; a path not already in its
// cleaned form is refused rather than resolved, as for a restricted account.
func impersonationMayReach(method, uri string) bool {
	p := uri
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	if method == "" || p == "" || strings.Contains(p, "%") || path.Clean(p) != p {
		return false
	}
	for _, r := range impersonationReach {
		if r.Method == method && segmentsMatch(r.Path, p) {
			return true
		}
	}
	return false
}

func segmentsMatch(pattern, p string) bool {
	want, got := strings.Split(pattern, "/"), strings.Split(p, "/")
	if len(want) != len(got) {
		return false
	}
	for i, w := range want {
		if strings.HasPrefix(w, ":") {
			if got[i] == "" {
				return false
			}
			continue
		}
		if w != got[i] {
			return false
		}
	}
	return true
}
