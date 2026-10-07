---
id: adr-0128
status: superseded
updated: 2026-10-07
---

# ADR 0128 — a reseller's domain reaches us through Fastly, and the origin has no public door

- **Status:** superseded by [ADR-0129](0129-a-resellers-domain-reaches-us-through-cloudflare-for-saas-and-a-tunnel.md) (2026-10-07, before anything was built)
- **Date:** 2026-10-06
- **Affects units:** tenant (domain lifecycle), panel-web (domains page), hosting (origin lockdown)
- **Decision row:** D-65 (the agent's recommendation, accepted by the user)
- **Supersedes:** `tenant/contract.domains.md` "Setting up the CDN (ArvanCloud)" (user, 2026-09-19). ADR-0063 stands unchanged.

## Context
Resellers point their own domain at us and expect it to work with nothing more
than a DNS record. The origin's address must never be public: an attack or a
filter on it takes every reseller down together.

The 2026-09-19 setup had each reseller run its own ArvanCloud zone, which is
manual per reseller. Cloudflare for SaaS automates this, but Iran disrupts
Cloudflare's addresses (user, 2026-10-06). Fastly's are not disrupted, and its
**versionless domains** (Domain Management API, outside the service's
versioned config, 500,000 per service) and per-domain TLS subscriptions let
the platform add a reseller's domain with API calls alone.

## Decision
1. **One Fastly service fronts every reseller domain.** Its origin is the
   gateway. It keeps the visitor's `Host` (ADR-0060, the resolver needs it) and
   carries WebSockets for the realtime path. Each reseller domain is a
   versionless domain linked to that service: `POST
   /domain-management/v1/domains {fqdn, service_id}`, never a service version.
2. **The reseller still CNAMEs to its own `<slug>.edge.<domain>`** (ADR-0063).
   `*.edge.<domain>` points at Fastly. The reseller's record never names
   Fastly, so changing CDN is a change to our zone, not to 100 resellers'.
3. **One certificate per domain** (catalog F-109): a Fastly TLS subscription
   per domain, ACME DNS challenge. The reseller adds, once,
   `_acme-challenge.<their domain> CNAME <label>.acme.<domain>`. We point that
   label at the target Fastly names. Certificates can then be issued before
   traffic moves, and on any later provider. Whether Fastly's CA follows this
   CNAME chain is unproven: EDGE-1-a proves it before anything is built on it.
   If it does not, the reseller's record names Fastly's target directly and
   decision 2 still holds for traffic.
4. **The provider is behind a port.** `tenant-service` calls an
   `EdgeProvider` (register, request certificate, read status, remove). Fastly
   is its first driver. Our database stays the list of domains; the CDN's copy
   is rebuilt from it.
5. **A domain is live when it is verified *and* its certificate is issued.**
   States after `verified`: edge `registering → issuing → issued`, or
   `failed` with what was expected and what was found. Renewal is Fastly's;
   `renew_failed` is shown (catalog 13.1 `tlsStatus`). The page follows each
   change over the socket (ADR-0121).
6. **The origin has no public door.** Only Fastly's published address ranges
   reach 80/443. Every request must carry a secret header Fastly adds, or the
   gateway refuses it. A connection to the bare address gets no real
   certificate. The origin's address changes once at go-live, because the old
   one is in public DNS history.

## Consequences
- The reseller's onboarding asks for three records (TXT, CNAME, `_acme-challenge` CNAME), each written once.
- An apex domain cannot CNAME. The panel asks for a subdomain (`panel.`, `www.`).
- `tenant_domain.arvanRegisteredAt` is replaced by the edge columns.
- Fastly's price for TLS subscriptions and WebSockets is unknown here. The user gets the quote before EDGE-1-c.
- `<slug>.edge.<domain>` still names the platform (catalog 13.4). Moving targets to neutral domains is a separate decision, not taken here.
