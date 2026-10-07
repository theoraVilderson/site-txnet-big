---
id: adr-0129
status: active
updated: 2026-10-07
---

# ADR 0129 — a reseller's domain reaches us through Cloudflare for SaaS, and the origin is reached only through a tunnel

- **Status:** accepted (nothing built yet — rows EDGE-1-a..EDGE-1-j)
- **Date:** 2026-10-07
- **Affects units:** tenant (domain lifecycle), panel-web (domains page), hosting (origin lockdown)
- **Decision row:** D-66 (the user, 2026-10-07)
- **Supersedes:** [ADR-0128](0128-a-resellers-domain-reaches-us-through-fastly-and-the-origin-has-no-public-door.md) (Fastly). ADR-0063 and ADR-0060 stand unchanged.

## Context
ADR-0128 chose Fastly because Iran disrupts Cloudflare's addresses. On
2026-10-07 the user chose Cloudflare anyway, accepting that risk. Two
Cloudflare features remove most of ADR-0128's moving parts. **Custom
Hostnames** (Cloudflare for SaaS) add a reseller's domain and its certificate
with one API call. A **Tunnel** (`cloudflared`) connects outward from our host,
so the origin can close 80/443 entirely: no address-range firewall and no
secret header to keep in step.

## Decision
1. **The platform zone (`<domain>`) is on Cloudflare.** Every reseller domain
   is a Custom Hostname on that zone (`POST /zones/{zone}/custom_hostnames`,
   `ssl.method: http`). Its fallback origin is a proxied CNAME to the tunnel
   (Cloudflare's SaaS reference architecture describes this; EDGE-1-a proves
   it). The visitor's `Host` reaches the gateway unchanged (ADR-0060), and
   WebSockets pass through (every plan).
2. **The reseller still CNAMEs to its own `<slug>.edge.<domain>`** (ADR-0063).
   That is a proxied record in our zone. The reseller's record never names
   Cloudflare, so changing CDN is a change to our zone, not to every reseller's.
3. **One certificate per domain** (F-109), issued and renewed by Cloudflare.
   It is validated over HTTP once the CNAME is in place, so there is no
   `_acme-challenge` record by default. A domain is live when it is verified
   *and* its certificate is active.
4. **A reseller may put its own CDN in front** (for example ArvanCloud, when its
   users are in Iran). That CDN's origin is `<slug>.edge.<domain>`. It sends the
   reseller's domain as `Host` and SNI, so the domain still arrives as itself
   (ADR-0063), and it is still a Custom Hostname on our zone. Cloudflare's HTTP
   validation needs the hostname to point at us, so such a domain is expected
   to validate by TXT records or DCV delegation instead (EDGE-1-d). EDGE-1-a
   proves which, and whether the reseller must touch a record at each renewal.
5. **The provider is behind a port.** `tenant-service` calls an `EdgeProvider`
   (register, status, remove). Cloudflare is its first driver. Our table is the
   list of domains, and the CDN's copy is rebuilt from it.
6. **States after `verified`:** edge `registering → issuing → issued`, or
   `failed` with what was expected and what was found. Renewal is Cloudflare's,
   and `renew_failed` is shown. The page follows each change over the socket
   (ADR-0121).
7. **The origin has no public door.** `cloudflared` on the swarm host is the
   only way in. 80/443 are closed on the host. The gateway takes the client
   address from `CF-Connecting-IP` only when the request came through the
   tunnel. The origin's address changes once at go-live, because the old one
   is in public DNS history.
8. **A response that depends on the signed-in user is `Cache-Control: private,
   no-store`**, so a reseller's CDN set to cache everything cannot serve one
   user's page to another. The domain check fails a domain that does.

## Consequences
- The reseller sets two records: TXT (ownership) and CNAME. A reseller with its own CDN also sets that CDN's origin, Host, SNI and WebSocket switch.
- An apex domain cannot be a Custom Hostname below Enterprise. The panel asks for a subdomain.
- **Risk accepted by the user:** in Iran, Cloudflare's addresses are disrupted at times. A reseller's own CDN (decision 4) is the escape, and decision 2 keeps a provider switch inside our zone.
- **Risk:** Cloudflare follows US sanctions, so the account is held outside Iran. The `EdgeProvider` port and decision 2 bound the cost of leaving.
- Price (Cloudflare docs, 2026-10-07): every plan, Free included, has 100 hostnames free, then $0.10 per hostname per month. The user confirms it in the account before EDGE-1-c.
- `tenant_domain.arvanRegisteredAt` is replaced by the edge columns. ADR-0128's ACME label, firewall ranges and secret header are not built.
