package sub

import "strings"

// NormalizeHost reduces a request's Host to the form
// `tenant_domain.domainValue` is stored in. It is the Go twin of
// `shared-core/src/lib/tenant/host.ts` `normalizeHost` and must agree with it:
// lowercased, port dropped (outside the brackets of an IPv6 literal), a
// trailing root dot removed. An empty result means no host.
func NormalizeHost(raw string) string {
	host := strings.ToLower(strings.TrimSpace(raw))
	if host == "" {
		return ""
	}
	if strings.HasPrefix(host, "[") {
		end := strings.IndexByte(host, ']')
		if end == -1 {
			return ""
		}
		host = host[:end+1]
	} else if colon := strings.IndexByte(host, ':'); colon != -1 {
		host = host[:colon]
	}
	return strings.TrimRight(host, ".")
}
