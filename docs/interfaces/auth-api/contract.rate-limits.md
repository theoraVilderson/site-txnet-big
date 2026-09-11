---
id: auth-api
layer: interface
status: active
version: 12
updated: 2026-09-11
---

# auth-api — rate limits

How the numbers in [contract.md](contract.md)'s endpoint table are actually
counted. Split out of `contract.md` at 250 lines (§10): the per-route values
stay in that table, and this file answers "against what, and how many
counters".

## Where a bucket name comes from

The counter key is `ratelimit:<tenantId>:<bucket>:<subject>`.
`RedisKeys.rateLimit()` owns the first half; the `<bucket>` segment is a
declared entry in `RateLimitBucket`
(`shared-core/src/lib/redis/rate-limit-buckets.ts`, C-05), joined to the subject
by `rateLimitBucketKey()`. That file is also the only place the platform's whole
rate-limited surface can be read at once.

It is normative because both failure modes are silent. Routes that must
**share** a budget have to name the same bucket — ordinary login and the
password-change check are two ways to guess one password, so the second would
otherwise become the cheaper door. Routes that must be **separate** must not
collide, and a collision only shows up as one route mysteriously running out of
an allowance it never spent.

## Two counters, and what each one is for

- **Every rate-limit bucket is per tenant** (F-1206, catalog 20.2 layer 6). The
  subject a route names — an IP, a bot chat id, a caller's user id, or the
  identity a login attempt was made against — is prefixed with the request's
  resolved tenant before it becomes a counter, in `RedisKeys.rateLimit` rather
  than in `rateLimitSubject()`, so the two captcha routes and the
  `login-failures:<identity>` counter are covered without having asked. Two
  resellers therefore never share a budget: an IP is the internet's and a chat
  id is the messenger's, so both arrive identical at every reseller's front
  door, and one tenant's traffic used to be able to lock out another's users —
  most sharply through `login-failures`, where ten bad passwords against one
  reseller's `admin` locked every reseller's. A request that resolved to no
  tenant is still counted, under a segment no tenant id can equal. The rule and
  what it costs are in `redis-keyspace/contract.md`.
- **A platform-wide ceiling sits over the same bucket** (F-066-s). Per-tenant
  buckets hand one caller a fresh budget for every tenant it can name, since
  the segment is chosen by picking a hostname. So every limit in the table
  below is counted twice: once against the request's tenant, and once against
  the whole platform under the same bucket string with no tenant in it. The
  platform ceiling is `PLATFORM_RATE_LIMIT_FACTOR` (default 10) times the
  route's own limit — a multiple, not `1`, because a large NAT legitimately
  reaches many resellers from one address — and `0` switches it off. It
  applies to the routes in the table and nowhere else: the per-account lock on
  `/auth/login/password` counts the account being guessed at rather than who
  is guessing, and counting *that* platform-wide would lock every reseller's
  `admin` out over one reseller's attacker. A request refused by either
  counter is the same 429; a client cannot tell them apart and must not try.
- **Every number in `contract.md`'s table is deployment config, not a fixed
  limit** (F-087, decided 2026-09-11). The value in the table is the default an
  environment that sets nothing gets; a deployment overrides it with an env
  change and a restart, never a rebuild. Each route's variable is
  `<BUCKET>_RATE_LIMIT` — for example `LOGIN_PWD_RATE_LIMIT` — with two
  exceptions kept for existing deployments: `CAPTCHA_RATE_LIMIT` covers both
  `/auth/captcha/*` routes, and `FORGOT_VERIFY_RATE_LIMIT` covers
  `/auth/password/forgot/verify-otp`. `LOGIN_FAILURE_LOCK_THRESHOLD` (the
  per-account lock) and `PLATFORM_RATE_LIMIT_FACTOR` (the ceiling above) are
  tunable the same way.

  The default is declared **once**, in auth-service's env schema. The route
  names its variable with a typed `configKey` and carries no number of its own,
  so a misspelled variable is a compile error and a default cannot be written
  twice and drift. Windows stay on the routes and are not tunable.

  A client must not assume any count: 429 and `auth.temporarilyLocked` are the
  contract, the numbers are not.

## What a client may rely on

429 is the contract; the counts are not, and neither is which of the two
counters refused. A client backs off and retries. It must not model either
budget, because a deployment moves both without a rebuild.
