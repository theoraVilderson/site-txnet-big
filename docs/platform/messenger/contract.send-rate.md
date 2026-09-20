---
id: messenger
layer: platform
status: active
updated: 2026-09-20
---

# messenger — the outbound ceiling

**Read this when** a send is being paced, refused for budget, or a new caller
starts sending. Why the ceiling lives here rather than in the sender, and what
was rejected, is ADR-0066 (`F-313-a`, `F-313-c`).

- **One budget per `(tenant x platform)`** — per bot, which is what a platform
  throttles and bans. Counted in Redis on a fixed one-second window;
  `RateLimitBucket.BOT_SEND` (C-05), key `UnscopedRedisKeys.outboundRate`
  (C-03), so the platform's whole rate-limit surface stays in one file.
- **Spent inside the driver**, not at the call site. A limiter a caller must
  remember to call is one a caller will forget.
- **Two ways to spend it, because there are two kinds of send** (`F-313-c`).
  `sendText` is the bulk one and can wait: over budget it answers `{ permanent:
  false, retryAfterSec }`, a real 429's shape, so no caller grew a branch.
  `sendMessage` and `sendInvoice` answer a person who is waiting — and
  `sendMessage` throws on failure — so they **count and go regardless**;
  refusing one would turn a spent budget into a failed login. Both hit the same
  counter, which is what makes the bulk sender's budget true: the only caller
  that can yield is the one that does.
- **Ceilings are dated, per platform, env-overridable** (`send-rate.ts`): a
  number with no source is not a ceiling, as with a capability flag. Telegram
  30/s is documented; Bale's 20/s is **not confirmed** and takes the lower value
  until `docs.bale.ai` is read — see [open-questions.md](open-questions.md).
- **Unbound is unpaced, and fail-open.** All three sending apps bind the store
  in their own `RedisModule`; a Redis that does not answer stops the counting,
  never the send. `clientForToken` is unpaced: no tenant yet (F-066-w5).

