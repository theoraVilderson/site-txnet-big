---
id: adr-0165
status: accepted
updated: 2026-10-25
---

# ADR 0165 — Iran keeps selling when the internet goes national: a domestic door beside Cloudflare, and a cluster that needs nothing from abroad

- **Status:** accepted (rows NIN-1-a … NIN-1-j)
- **Date:** 2026-10-25
- **Decision:** the user's (2026-10-25: "a way through Cloudflare, and no
  trouble from Iran when the internet goes national"; market is Iran first,
  no foreign market yet)
- **Affects units:** hosting (origin, nodes, build, alerts, backup), tenant
  (the platform's doors, a reseller's domain)
- **Amends:** ADR-0129 decision 4 (a reseller's own CDN reaches us without
  crossing Cloudflare); the 2026-10-25 row of `hosting/open-questions.md`
  (mytxnet.ir is left alone, point 9). Extends ADR-0147, ADR-0164.

## Context

When Iran cuts the international links ("national internet"), a visitor in
Iran reaches only Iranian addresses. Checked against the stack on 2026-10-25:

- `txnet.cyou` is a foreign TLD on Cloudflare's nameservers: unresolvable
  inside Iran. Cloudflare's edge is unreachable, and O7 admits nobody else.
- Traefik renews Let's Encrypt over HTTP-01: renewal fails, HTTPS ends in weeks.
- `k8s-add-node.sh join` fetches `install.sh` from GitHub; every image build
  runs `npm ci` against npmjs: no node joins and no release builds.
- Alertmanager sends to Telegram only: the owner hears nothing.
- What ArvanCloud offers (its CDN docs, read 2026-10-25): the visitor's
  address in `X-Real-IP`; its ranges at `arvancloud.ir/en/ips.txt`; HTTP or
  HTTPS to any origin port, per record (`upstream_https`, `host_header`).
  Custom headers to the origin are Enterprise-only, and no client certificate
  to the origin is documented; WebSockets and a self-signed origin certificate
  are not documented either. NIN-1-a tries each.
- Already domestic and unaffected: both nodes, the registry (Arvan CaaS), the
  image mirror, Zarinpal/IDPay, the SMS drivers, Bale, IRR rate sources
  (ADR-0098). Telegram is lost to Iranian users whatever we build.

## Decision

1. **Two doors to the same cluster.** A domestic door, a second `.ir` domain
   with DNS and CDN on ArvanCloud (tried on `barghgho.ir`, user 2026-10-25;
   production's domain is named later), and the Cloudflare
   door, `txnet.cyou`. Both reach the same nodes in Iran. On national internet
   only the Cloudflare door closes.
2. **The domestic domain is primary.** Every link a user keeps or a domestic
   system calls back — the subscription URL, a gateway's return URL, Bale's
   webhook — is built on it, since it is reachable from both sides of a cut.
   Telegram's webhook stays on the Cloudflare door.
3. **The origin admits each edge by its own proof.** O7's firewall admits
   Cloudflare's ranges, and on the domestic door's port those of every
   approved edge (point 7; Arvan first), each kept from its last good copy; each edge is verified by its own method and only a verified edge's
   visitor header becomes the client address (O5). Below Arvan's Enterprise
   plan the only proof is its ranges: any Arvan customer can then reach the
   origin, still only for hosts we route and with Arvan's own `X-Real-IP` —
   a weaker door than Cloudflare's, accepted unless NIN-1-a finds better.
4. **No origin certificate needs the foreign internet to stay valid.** Edges
   terminate the visitor's TLS; the origin presents long-lived certificates
   (Cloudflare Origin CA for its door, NIN-1-a's answer for Arvan), alerted 30
   days before expiry.
5. **The cluster lives in Iran, and only there.** Stores, payment and the
   control plane stay on Iranian nodes. A foreign server, if one is added, is
   never a node of this cluster (a cut splits it and its pods lose the
   stores); it holds no data and serves only what needs the foreign internet.
6. **Growing needs nothing from abroad.** A node joins from the server's
   checkout alone (k3s binary, `install.sh` at K1's pin, images from the
   mirror); images build from a domestic package cache warmed by every build;
   nodes keep time from a domestic source; alerts also go to Bale.
7. **A reseller's domain can survive the cut, through its own Arvan account.**
   No reseller's domain is ever added to our ArvanCloud account (user,
   2026-10-25: managing other people's domains in ours is not right), which
   rules out registering it there by NS delegation, and Arvan's CNAME Setup
   (Enterprise-only, and also in our account). The reseller's own Arvan points
   at a domestic origin name of ours — DNS-only, so it never chains through our
   CDN — not at `<slug>.edge.txnet.cyou`, which crosses Cloudflare. Ownership
   is the TXT proof already built (EDGE-1-n); the domain check then names what
   is wrong in its Arvan settings. Such a domain is not a Custom Hostname. One
   on Cloudflare alone closes with the cut; the domains page says so.
   **Other CDNs come from a list of approved edges** (user, 2026-10-25): each
   row is a name and where its published ranges are read, so adding one is
   data, not code (C-18). Arvan is the first row. A CDN not on the list still
   works through today's Cloudflare path, and is told it closes with the cut.
   **A reseller wanting no CDN keeps today's path** (one record, our
   Cloudflare): a domain pointed straight at our address is refused, since one
   filtered domain would take the shared address and every tenant with it
   (ADR-0063's reason), expose the origin, and leave its certificate needing
   the foreign internet.
8. **It is proven by a drill, not by reading.** `nin-drill` closes egress to
   every non-Iranian address on all nodes for a bounded time, runs the release
   smoke check through the domestic door (sign-in, purchase, subscription,
   Bale), then reopens. A change that breaks it fails it.
9. **mytxnet.ir is not touched** (user, 2026-10-25). Its site, panel and
   records, `api.` and `registry.` included, stay as they are; nothing here
   moves, repoints or proves anything on it. Whether the new platform ever
   takes those names is a later decision of the user's.

## Consequences

- Positive: a cut costs the international buyers and Telegram, not the
  Iranian sale; a node or a release goes on during one.
- Negative / accepted cost: two CDN accounts, two range lists and two origin
  proofs to keep; ArvanCloud bills traffic (ADR-0156 records it as a cost).
- Negative / accepted cost: the package cache is a service to run, and a
  dependency never fetched before a cut cannot be added during it.
- Off-node backups go to a domestic bucket (user, 2026-10-25: Iran first, no
  money abroad yet; NIN-1-i). A copy abroad, against losing the datacenter
  itself, waits for a foreign bucket (NIN-1-k); until then one country holds
  every copy.

## Alternatives rejected

- **Cloudflare only** (the 2026-10-25 plan): no sale in Iran during a cut.
- **ArvanCloud only**: rebuilds EDGE-1's Custom Hostnames for a future foreign
  market, and foreign visitors pay an Iranian CDN's path.
- **A foreign node in this cluster**: split by every cut, and K17's 10 ms bound
  makes it a standby at best.

## Amendment 1, 2026-10-25 — each door is its own Traefik (NIN-1-b2)

Point 3 assumed the domestic door is another entrypoint of the one Traefik. It
cannot be: Traefik picks the handshake rule for a host no route names from its
single `default` TLS options, and per-entrypoint options reach `Host()` routes
only (v3.7, tried 2026-10-25: `panel.example.ir` served on 8443 without a
certificate, `shop.reseller.ir` refused). Every reseller's domain is such a
host, so one process would hold the domestic door to Cloudflare's certificate,
or loosen 443. The user chose (2026-10-25) a second Traefik for the domestic
door, on the same image and routes, with its own `default` (no certificate),
and later its own visitor header (NIN-1-b3) and certificate (NIN-1-c1); a
change on one door cannot open the other. Cost: one more pod. The cheaper
choice — a second copy of each route with its own TLS options — served only
the platform's own hosts and would have been rebuilt at NIN-1-e. Cloudflare's
ranges never reach 8443: nothing there checks a certificate, and Cloudflare
proxies 8443 for any zone. Rules: hosting `contract.origin.md` O7, O12.
