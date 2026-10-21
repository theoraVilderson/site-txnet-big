package sub

import (
	"context"
	"strings"
)

// servesLegacy is the routing rule for an old panel's subscription host
// (F-204-a): a `legacy_sub` domain, once the reseller proved it. It answers
// the old links an import kept (F-203-b) and the panel's own `/sub/{token}`.
func servesLegacy(d Domain) bool {
	return d.Purpose == "legacy_sub" && d.DomainType == "custom_domain" && d.VerificationStatus == "verified"
}

// LegacyPath is a request path in the form `legacy_sub_link.path` keeps
// (entitlement contract.import.md rule 29): decoded, as `URL.Path` already
// is, without its trailing slash, since an app may fetch it either way.
func LegacyPath(path string) string {
	return strings.TrimRight(path, "/")
}

// grantFor is the Grant a request names on its host. On an old panel's host
// the old link comes first; on it and on a subscription domain, the token,
// which is one path segment, of the domain's own tenant (C-16). Anything else
// is no Grant, so every miss is the same 404.
func (h *Handler) grantFor(ctx context.Context, d Domain, host, rest, path string) (Grant, bool, error) {
	switch {
	case servesLegacy(d):
		g, ok, err := h.store.GrantByLegacyPath(ctx, d.TenantID, host, LegacyPath(path))
		if err != nil || ok {
			return g, ok, err
		}
	case !servesSubscriptions(d):
		return Grant{}, false, nil
	}
	if strings.Contains(rest, "/") {
		return Grant{}, false, nil
	}
	g, ok, err := h.store.GrantByTokenHash(ctx, TokenHash(rest))
	if err != nil || !ok || g.TenantID != d.TenantID {
		return Grant{}, false, err
	}
	return g, true, nil
}
