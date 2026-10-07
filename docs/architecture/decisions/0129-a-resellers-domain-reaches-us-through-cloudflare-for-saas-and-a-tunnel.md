---
id: adr-0129
status: active
updated: 2026-10-07
---

# ADR 0129 — a reseller's domain reaches us through Cloudflare for SaaS, and the origin is reached only through a tunnel

- **Status:** accepted, amended 2026-10-07 (amendment 1: no tunnel) — rows EDGE-1-a..EDGE-1-j
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

## Amendment 1 — no tunnel; the origin answers only Cloudflare's pull certificate (2026-10-07, D-70)
EDGE-1-a's first step failed on the dev host: from Iran, `cloudflared` cannot
hold a tunnel. QUIC (UDP 7844) gets no answer, a direct TLS handshake on TCP
7844 is cut, and through the host's foreign proxy the handshake completes but
the edge never opens the HTTP/2 session. Cloudflare -> origin on 443 works
(the dev panel is served that way). A tunnel through the proxy would hang every
reseller domain on that proxy and on 7844 staying open. The user chose:
- Decision 1: the fallback origin (`EDGE_FALLBACK_ORIGIN`) is a **proxied
  record to the origin**, not to a tunnel. `*.edge.<domain>` CNAMEs to it.
- Decision 7 is replaced: the origin keeps 443 open but **answers only
  Cloudflare**. Authenticated Origin Pulls use a certificate issued for our zone,
  never Cloudflare's shared one (any Cloudflare customer can send that one).
  Traefik's websecure entrypoint requires it. On the swarm host, the firewall
  also admits 80/443 from Cloudflare's published ranges only. `CF-Connecting-IP`
  is trusted only on a verified pull. The address change at go-live stands.
- Dropped: `cloudflared`, the tunnel, and its token.

## Amendment 2 — behind a reseller's own CDN, an address counts as two (2026-10-07, D-71)
EDGE-1-g proved that Cloudflare names the visitor only for the hop it sees: a
domain behind the reseller's own CDN (decision 4) arrives with that CDN's edge
as `CF-Connecting-IP`, so every visitor through one Arvan edge shared one
per-IP budget, and one attacker could spend it for all of them. The user wanted
it to work for any CDN, with no setup by the reseller, no captcha and no
address list to keep in step. Decided:
- The verified client address stays the only `req.ip`: audit, fraud and every
  log keep the address Cloudflare saw. Nothing a CDN says replaces it.
- On a verified pull, the gateway plugin forwards what the CDN *claims* the
  visitor was as `X-Edge-Claimed-Ip`, from the first of a configured list of
  CDN client headers (`True-Client-IP`, `AR-Real-IP`, …). It never trusts the
  claim. A client cannot set the header itself: the plugin removes it first.
  `X-Forwarded-For` cannot carry the claim: Traefik drops it from an untrusted
  sender before any middleware runs.
- A per-IP limit with a claim is two counters: the address and the claim
  together at the route's own limit, and the address alone at
  `EDGE_SHARED_ADDRESS_FACTOR` times it. Visitors behind one CDN edge each get
  their own budget. A forged claim buys at most the coarse ceiling, and the
  limits on each account and phone number still hold. With no claim, nothing
  changes. A CDN whose header is not listed counts as one caller, as before.
- Rejected: a list of each CDN's address ranges (always behind with many CDNs,
  and other customers of the same CDN can still send any claim), and a key per
  domain set by the reseller in the CDN (one more step to forget).
Rows EDGE-1-k (gateway), EDGE-1-l (limiter).
