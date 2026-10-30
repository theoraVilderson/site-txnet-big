---
id: adr-0168
status: accepted
updated: 2026-10-29
---

# ADR 0168 — Staging holds a scrubbed copy of production, and production waits for the owner's approval

- **Status:** accepted (rows OPS-1-ah-f … OPS-1-ah-k)
- **Date:** 2026-10-29
- **Decision:** the user's (2026-10-29: «بعد اینکه من تایید دادم که تو حالت staging
  همه چی اوکیه حالا میتونه بره پروداکشن، سر خود نره»; and on the risk: «شاید پنل
  یارو دست بخوره، وقتی کانتک باشه باهاش»)
- **Affects units:** hosting (release, staging)
- **Amends:** ADR-0166 points 2 (no route out: one named exception, point 5
  below) and 5 (the gate is the owner's, not the twin's alone).

## Context

ADR-0166's twin restores production's data into staging with no route out, and
that closed network is the only thing between the copy and the real world. The
copy still names every real contact: the resellers' panels (4 of production's
10 kept their real addresses on 2026-10-29, unreachable only for want of a
route), users' phones, emails, Telegram and Bale chats, the bots' tokens, the
gateways' keys. One mistake in the network — a route, a proxy — and a real
user is messaged or a real panel disables a real client.

The owner also wants to test by hand — buy, renew, the bot, notices — on real
data before a release, and to decide when it goes out. The twin's
checks see only what was written into them.

## Decision

1. **Nothing real is left in the copy.** Right after the restore, before any
   service of staging starts:
   - **Panels** — each is pointed at a local test panel of its family, or its
     address and credentials are wiped and its collection stopped. A guard reads
     every panel row and refuses to start staging if one names an address that
     is not a local panel.
   - **People** — every phone, email, Telegram and Bale chat id and payment
     detail replaced by a fake one (phones `0912000xxxx`, email to mailpit).
   - **Keys** — the bots' tokens replaced by the dev bot's, SMS by a stub,
     every gateway put in its sandbox.
2. **Two layers, always.** The closed network stays; scrubbing is the second
   layer, so one mistake reaches nothing real. Point 1's panel rule applies to
   the automatic twin as well, at once (OPS-1-ah-f).
3. **The owner tests by hand.** `staging.sh open` lets the owner's browser reach staging
   from their own computer through ssh, presenting the origin-pull pair Traefik
   requires (O3). What they change lives in the copy and goes at `down`.
4. **Production waits for the owner.** `release.sh` builds, runs the twin and
   leaves staging up for the owner; it never pushes or deploys on its own. Only the
   owner's explicit approval of that same commit, recorded by the owner, lets the
   send step run; a newer commit needs a new approval.
5. **One way out, for the test bot only.** Staging may reach the dev bot's API
   (Telegram, Bale), so notices can be seen arriving; never a panel, a gateway,
   SMS or mail.
   *How (user, 2026-10-30):* a gate container, not a route. Staging's services
   are aimed at it in the cluster's own env Secrets, with webhook registration
   off. It forwards only the dev bots' sending and reading calls. Without it,
   staging would register the dev bot's webhook on production's domain, since
   staging runs production's env, at any commit (OPS-1-ah-j, R18).

## Consequences

- A release is: work on dev → `release.sh` (build, twin, staging stays up) →
  the owner tests → the owner's approval → push, ship, deploy.
- The dev stack stays stopped while the owner tests (memory is lent, ADR-0166
  point 6).
- Each new kind of contact a feature adds (a new channel, a new gateway) must be
  added to the scrub in the same change, or the guard misses it.
- Rejected: a seeded fake dataset (misses data bugs such as LIVE-1-z; the user
  chose production's data for ADR-0166) and a separate pre-production server
  (a cost, and it would need this scrub anyway).
