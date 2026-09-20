---
id: adr-0066
status: accepted
updated: 2026-09-20
---

# ADR 0066 — A bot's send ceiling belongs to messenger, not to the sender

- **Status:** accepted 2026-09-20 with F-313-a (user); amended the same day by F-313-c
- **Date:** 2026-09-20
- **Affects units:** messenger, notification, bot-app

## Context
`messenger/open-questions.md` has carried this since 2026-09-05: rate limiting
is named in two places — §9.8 "a queue resilient to bot bans" and `F-313` bulk
sending — and Bale documents a `/business/` path with *higher* limits, so the
ceiling is per-path, not merely per-platform. Does the queue belong to
`messenger`, which knows the limits, or to `notification`, which knows the
audience? Its exit path was "an ADR when `notification` starts". `notification`
has started: F-035-d, F-035-e, F-035-f, F-035-h and F-035-i-a are all done.

What `F-313` asked for turned out to be mostly built. Segmentation is the
fan-out's `filterCriteria` (F-035-d). The queue is the recipient rows and their
`FOR UPDATE SKIP LOCKED` claim (F-035-d, F-035-e). §9.8's resilience — the queue
surviving a banned token — is F-066-h: the token is a `credentialRef` into the
vault, not a column, so a tenant registers a new one and the same rows resume.

One piece was missing, and it is not a queue. Every send today discovers the
ceiling by hitting it: `campaign-delivery.service.ts` sends until a platform
answers `429`, then holds that bot until `retry_after`. The limit is real, it is
per bot, and nothing counts against it before the platform does.

## Decision
The outbound ceiling is a property of a bot on a platform, so it is enforced in
`messenger`, inside the driver, for every caller. `notification` keeps the
queue: it owns the audience, the recipient rows and the claim.

1. **One budget per `(tenant x platform)`**, counted in Redis on a fixed
   one-second window — the same shape as the inbound limiter, and declared in
   the same registry (`RateLimitBucket.BOT_SEND`, C-05) so the platform's whole
   rate-limit surface stays readable in one file. The key is built by
   `UnscopedRedisKeys.outboundRate` (C-03): the subject already names the
   tenant, and a worker has no `TenantContext` to scope it by.
2. **Enforced in `TelegramLikeBotClient`, not at the call site.** A limiter a
   caller must remember to call is one a caller will forget. The client asks
   before each message-sending call, so pacing arrives with the driver.
3. **Refused the same way the platform refuses.** Over budget returns the
   existing `{ ok: false, permanent: false, retryAfterSec }` — byte-identical to
   a real 429. Every caller already handles that shape, so no call site changes:
   campaign delivery defers the row to the next run, a bot flow logs and moves
   on.
4. **The ceilings are per platform and dated**, as `capabilities.ts` requires of
   a capability flag: a number with no date and no source is not a ceiling.
   Each is overridable by env, because Bale's `/business/` path proves the
   number is a deployment's property and not the code's.

## Consequences
- The pacer is a `messenger` service bound by whoever imports `MessengerModule`.
  **F-313-a bound only `notification-service`**, the one bulk sender; that left
  the budget a floor on what a bulk run consumes rather than a statement about
  the bot's real allowance. **Amended 2026-09-20 by F-313-c** (user), which
  closed it: all three sending apps bind the store in their own `RedisModule`,
  beside `RATE_LIMIT_STORE`.
- **An interactive send counts but is never refused.** `sendMessage` and
  `sendInvoice` answer a person who is waiting, and `sendMessage` throws on
  every failure, so refusing one for budget would turn a spent counter into a
  failed login. They spend and go; `sendText`, the bulk path, is the one that
  yields. That asymmetry is the decision, not a compromise: the only caller
  that *can* wait is the one that should, and counting the rest is what makes
  its budget true.
- A store is still optional, and the counter fails open: an app that binds none,
  or a Redis that does not answer, loses the counting and not the sends. The
  alternative is a Redis outage that silently takes every tenant's OTP delivery
  with it.
- Telegram's 30/s is documented; Bale's is not confirmed against `docs.bale.ai`,
  so it takes the lower default and keeps a dated open question. The
  `/business/` path stays unmodelled: one ceiling per platform, not per path.
- The window is fixed, not a token bucket, so a burst may land at the seam of
  two windows — at worst twice the ceiling across two adjacent windows. At the
  sizes here (a run sends at most 100 rows over 40s, and interactive traffic is
  a person typing) that stays far under either platform's real limit. A token
  bucket is the upgrade if a burst ever reaches one, and nothing above it has
  to change: both callers already ask this object rather than compute a rate.

## Alternatives considered
- **The queue and the ceiling both in `notification`.** Cheaper today: every
  line of delivery code is already there, and `cross-tenant-prisma` is at hand.
  Rejected on the long run. A ban or a throttle happens to a *bot*, not to a
  campaign, and the next senders — transactional bot messages, OTP delivery,
  F-405's "my connection isn't working", F-1531's daily summary — would each
  re-implement pacing or skip it. Then a campaign crawls politely while another
  path drives the same bot into its ceiling and takes the tenant down. That
  failure is invisible until a reseller's bot is banned.
- **Leaving it reactive.** A 429 is information bought by having already
  misbehaved, and platforms answer repeated floods with a ban rather than
  another 429 — which §9.8 names as the thing to survive.
