---
id: conventions
status: active
updated: 2026-09-11
---

# House style

Rules about **how code is written**, as opposed to what it does. Business rules
live in a unit's `rules.md`; those are about the product. These are about the
codebase, and they apply everywhere.

Read at tier 4 — before writing code inside any unit.

## The format

Every convention gets a permanent id (`C-nn`), cited in review and in commit
messages the same way a catalog id is. The `enforced by` column is the honest
part of this file: it shows at a glance which rules are actually held and which
ones are only hoped for.

| enforced by | means |
|---|---|
| `check` | `python3 tools/conventions.py` fails on a violation |
| `lint` | your linter fails on it (rule named in the notes) |
| `review` | nothing enforces it. It will be violated eventually. |

A convention that keeps getting violated does not need a firmer sentence. It
needs to move up that table.

## Conventions

| id | rule | enforced by |
|---|---|---|
| C-01 | Technical docs, code, commit messages and logs are in English. Existing Persian inline comments may stay; do not add new ones. | review |
| C-02 | Money is base-currency `Decimal` only — never a second currency column, never written as a float. One exception: a payment's gateway receipt, `amountReceivedMinor` + `receivedCurrency` (D-32). Balances are ledger-derived; never write a balance field directly outside a ledger-append transaction. See ADR-0002. | review |
| C-12 | A Nest route or middleware path names its wildcard: `'{*path}'`, `'internal/*path'`, `@Get('*key')`. A bare `*` — `forRoutes('*')`, `'internal/*'` — is a violation. | check |
| C-11 | A backend app that opens a tenant scope (`runWithTenant(...)`) registers `TenantStatusGuard` as an `APP_GUARD`, so every route it serves obeys `TenantStatusPolicy`. See `docs/domains/tenant/rules.md`. | check |
| C-10 | A panel route is a constant in `site-pwa/src/lib/routes.ts`. A path literal in `href=`, `redirect(` or `router.push/replace(` is a violation. | check |
| C-09 | A closed set of wire values is declared once — a Prisma enum (`z.nativeEnum`) or an `as const` tuple beside its type — and a zod schema derives from it. A hand-written `z.enum([...])` is a violation (env validation excepted). | check |
| C-08 | A broker routing key or outbox event type is imported from `shared-core/src/lib/automation/routing-keys.ts` (or `bot-update.ts` / `outbox.ts`). Nothing else spells one. | check |
| C-07 | A backend i18n key is a generated constant — `BackendI18nKeys.*`, or `BotKeys.*` in `bot-service`. A literal key in `key:` or an exception constructor is a violation, and so is a key spliced from a template: a key chosen at runtime comes from an exhaustive `Record` over its union. See ADR-0036. | check |
| C-06 | An i18n key in the panel is referenced through the generated constants (`site-pwa/src/generated/i18n-keys.ts`). A bare string literal as the key of a `t(...)` call is a violation. Keys built by concatenation are F-084's exhaustive maps, not literals. See ADR-0036. | check |
| C-05 | A rate-limit bucket is a `RateLimitBucket` registry entry joined with `rateLimitBucketKey()`. A bare string where a bucket belongs is a violation. See ADR-0036. | check |
| C-04 | A header, cookie or permission name that crosses a process boundary is declared in `contracts/http/wire.json` and imported from `shared-core/src/lib/http/` (TypeScript) or `auth-handler/internal/api/handlers/headers.go` (Go). Nothing else writes one as a literal. See ADR-0036. | check |
| C-03 | Redis keys are built only through `RedisKeys.*` (`shared-core/src/lib/redis/keys.ts`, re-exported per app) or `cache.SessionKey` in Go — nothing else hand-writes a key string. Every key is prefixed `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`. See `docs/platform/redis-keyspace/contract.md`. | check |

---

## C-03 — Redis keys go through `RedisKeys` only

**Rule.** Every Redis command's key argument is built via `RedisKeys.*` (Node)
or the equivalent Go builder in `auth-handler`. A raw template-literal key
passed straight to a Redis call is a violation.

**Why.** `REDIS_KEYSPACE_VERSION` exists so the entire keyspace can be
abandoned at once (a forced logout of every session) by bumping one value. That
only works if every key is actually built through the shared prefix — a
hand-written key string silently escapes the version bump and the namespace,
and now "log everyone out" quietly leaves sessions alive.

```ts
// wrong — escapes RedisKeys and the namespace prefix
await this.redis.set(`otp:code:${purpose}:${phone}`, hash);

// right
await this.redis.set(RedisKeys.otpCode(purpose, phone), hash);
```

**Two check blocks, because the violation lived where the first one could not
look.** C-03 has always said "or the matching `auth-handler` config", and no Go
builder existed: the gateway concatenated `h.keyPrefix + "session:" + id`
inline — the exact raw key string this rule forbids, in the one language the
check did not cover. F-076 built `internal/cache/keys.go` and the second block
below is what keeps it the only place that does it.

The `except:` list is also narrower than it was. It used to exempt every
`*.spec.ts`, which exempted the files most likely to hand-write a key while
asserting one; now only the catalogue and its own contract spec are outside.

```check C-03
forbid: redis\.(get|set|del|expire|incr|decr|hset|hget|hdel|sadd|srem|exists)\(\s*`
in: txnet-backend/**/*.ts
except: txnet-backend/shared-core/src/lib/redis/**, txnet-backend/**/redis.keys.ts, txnet-backend/**/redis-fixture.ts
message: build the key through RedisKeys.* (redis.keys.ts) — never a raw template-literal key (C-03)
```

```check C-03
forbid: keyPrefix\s*\+
in: auth-handler/**/*.go
except: auth-handler/internal/cache/keys.go
message: build the key through cache.SessionKey (internal/cache/keys.go) — never concatenate the keyspace prefix by hand (C-03)
```

---

## C-02 — money is base-currency `Decimal`, balances are ledger-derived

**Rule.** A monetary value is stored once, as `Decimal`, in the system's single
base currency. No monetary table gets its own currency column. The one exception is `payment_transaction`'s gateway receipt (`amountReceivedMinor` + `receivedCurrency`, D-32): evidence of what arrived, never credited as is — `amountCredited` stays base. A wallet-style
`cachedBalance` is never written outside the same transaction that appends the
proving ledger row.

**Why.** Storing an amount in more than one currency, or trusting a cached
balance as truth, guarantees the two copies drift — and the drift is discovered
as a refund or a payout that does not reconcile, usually months later. See
ADR-0002 for the full reasoning and the units it binds.

**Not mechanically checkable here** — telling a legitimate cache field from a
truth-bearing one needs the transaction boundary, not a regex. This lives in
review until a domain implementing it exists; when `billing` goes from `draft`
to `active`, revisit whether its repository layer can carry a real `check`.

---

## C-01 — English only

**Rule.** Docs, code, commit messages and logs are written in English. Persian
inline comments that already exist in the code may stay as-is; do not add new
ones.

**Why.** A polyglot backend (Go + TypeScript) already forces contributors to
context-switch between two languages; mixing in a third for comments makes
`git blame` and code review slower for the next person, whoever they are.

**Not mechanically checkable** — a comment can't be judged English/Persian by
a cheap regex without false positives on names, URLs and error codes. Held in
review.

---

## C-04 — a boundary-crossing name is declared once and imported

**Rule.** Every HTTP header, cookie and permission name that crosses a process
boundary is declared in `contracts/http/wire.json` and imported from the
language binding beside it — `shared-core/src/lib/http/` in TypeScript,
`auth-handler/internal/api/handlers/headers.go` in Go. Nothing else writes one
as a literal.

**Why.** These names are spelled in Go, in TypeScript and twice more in Traefik
YAML — a forward list and a strip list — and nothing joins the four copies.
They were kept in step by comments, and they had already drifted: `X-Actor-Id`
sat in Traefik's strip list while no writer and no reader had ever used it. The
failure mode is the expensive kind, because nothing is red: a header dropped
from `authResponseHeaders` reaches a consumer as an absent value, and an absent
`X-Session-Id` means a socket that outlives a revocation for ever. See ADR-0036.

```ts
// wrong — a second spelling of a name the fixture already owns
const userId = req.headers['x-user-id'];

// right
const userId = headerValue(req.headers, IdentityHeaders.userId);
```

**A check block cannot verify that two files agree** — `tools/conventions.py`
matches per-file regexes and has no cross-file comparison. So the check below
does the half it can, forbidding a raw literal, and the set comparison is done
by three tests instead: `wire.contract.spec.ts`, `headers_contract_test.go` and
`tools/contracts.py` for the Traefik lists.

**Two files stay in `except:` permanently, and they are not debt.**
`broker.service.ts` spells `x-attempts`, an AMQP message header on a different
transport entirely; `webhook.controller.ts` spells
`x-telegram-bot-api-secret-token`, which is Telegram's name and not ours to
declare. Neither crosses a boundary this contract owns. The payment drivers
(`payment/gateway/*.provider.ts`) are the same case: `x-nowpayments-sig` and
`x-api-key` are a provider's names on its own wire (F-104-h). The two broker
classes are that case once more: `x-dead-letter-exchange` is RabbitMQ's own
queue argument, not a name on a wire this contract owns. `site-pwa` is not in
the Nx workspace and cannot import `shared-core`; it imports the same names
from `@/generated/wire`, which `tools/wire-gen.py` writes from `contracts/` and
`tools/contracts.py` fails on when stale (ADR-0036 amendment 2026-09-14). The
second check block below holds it to that.

```check C-04
forbid: ['"]x-[a-z0-9]+(-[a-z0-9]+)+['"]
in: txnet-backend/**/*.ts
except: txnet-backend/shared-core/src/lib/http/**, txnet-backend/**/*.spec.ts, txnet-backend/worker-service/src/app/broker/broker.service.ts, txnet-backend/metering-service/src/app/broker/broker.service.ts, txnet-backend/billing-service/src/app/traffic/hot-loop.queue.ts, txnet-backend/bot-service/src/app/webhook/webhook.controller.ts, txnet-backend/billing-service/src/app/payment/gateway/*.provider.ts
message: import the name from shared-core/src/lib/http (C-04) — a header spelled twice is the drift ADR-0036 exists to stop
```

```check C-04
forbid: ["'](x-[a-z0-9]+(-[a-z0-9]+)+|X-[A-Za-z0-9]+(-[A-Za-z0-9]+)+|refresh_token)["']
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx
except: site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx, site-pwa/src/generated/**
message: import the name from @/generated/wire (C-04) — it is generated from contracts/http/wire.json; add a name there, then run python3 tools/wire-gen.py
```

---

## C-05 — a rate-limit bucket comes from the registry

**Rule.** The `<bucket>` segment of `ratelimit:<tenantId>:<bucket>:<subject>` is
an entry in `RateLimitBucket` (`shared-core/src/lib/redis/rate-limit-buckets.ts`),
joined to its subject by `rateLimitBucketKey()`. No call site writes the segment
as a literal.

**Why.** It is part of a Redis key, and both ways it goes wrong are silent.
Two routes that mean to **share** a budget must spell it identically:
`login-failures:<identity>` was hand-written in two places with a comment
between them saying they had to stay the same, which is the clearest possible
statement that nothing was making them. Two routes that mean to be **separate**
must not collide, and a collision just makes one spend the other's allowance
with no error anywhere. Several bucket names also duplicate real key families —
`otp:delivery:`, `bot:session:`, `captcha:challenge:`, `register:` — so a reader
scanning the keyspace cannot tell a counter from the thing it counts.

```ts
// wrong — a key segment with no builder and no check
@RateLimit({ key: (req) => `login:pwd:${rateLimitSubject(req)}`, ... })

// right
@RateLimit({
  key: (req) => rateLimitBucketKey(RateLimitBucket.LOGIN_PWD, rateLimitSubject(req)),
  ...
})
```

The check matches the shape rather than the names: a template literal in the
`key` position of a `@RateLimit` decorator. It cannot tell a *correct* literal
from a wrong one — nothing per-file can — but the registry is the only way to
produce a bucket without one, so forbidding the shape is enough.

```check C-05
forbid: key:\s*\([^)]*\)\s*=>\s*`
in: txnet-backend/**/*.ts
except: txnet-backend/**/*.spec.ts
message: build the bucket with rateLimitBucketKey(RateLimitBucket.X, subject) (C-05) — a bare bucket string is a key segment nothing checks
```

---

## C-06 — a panel i18n key comes from the generated constants

**Rule.** In `site-pwa`, the key passed to `t(namespace, key)` is a generated
constant — `t("common", C.accounts.add)` where `C = FrontendI18nKeys.common` —
never a string literal.

**Why.** Both locale clients return the key itself when it is missing and never
throw, so a typo or a key renamed in `locales/` renders as a raw dot path on a
real screen with every suite green. A generated constant turns that into a
compile error at the call site. F-083 migrated the last static literal sites and
deleted the twenty keys nothing reached, so this block is green from the day it
exists — added earlier, it would have been red for three sessions and learned to
be ignored.

```tsx
// wrong — renders "accounts.addd" to the user, compiles fine
{t("common", "accounts.addd")}

// right — does not compile
{t("common", C.accounts.addd)}
```

The regex matches a quoted namespace followed by a quoted key. A template
literal key (`` `accounts.proof.${option}` ``) is not matched on purpose: those
are dynamic families, held by exhaustive maps (F-084), and a regex cannot tell a
correct one from a wrong one.

```check C-06
forbid: \bt\(\s*["'][a-z]+["']\s*,\s*["']
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx
except: site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx, site-pwa/src/generated/**
message: pass a generated constant from @/generated/i18n-keys as the key (C-06) — a literal key that is wrong renders as the raw key and fails nothing
```

---

## C-07 — a backend i18n key comes from the generated constants

**Rule.** C-06 for the backend. A key in a `BotText` (`{ key: ... }`), in a
service result's `key:`, or as the message of a Nest exception is a generated
constant: `BackendI18nKeys.errors.otp.channelNotConfigured`, or
`BotKeys.action.cancel` in `bot-service`.

**Why.** Same failure as C-06, in a chat instead of a screen: `BotCopy` and the
exception filter both render a missing key as itself, so a key renamed in
`locales/backend` put `bot.action.login` on a button with every suite green —
and `BackendI18nKeys` had existed since F-080 with ~150 call sites not using it.

`BotKeys` (`bot-service/src/app/locale/bot-keys.ts`) is the generated `bot`
namespace with the `bot.` prefix `BotCopy` routes on; the strings are
byte-identical.

**A key chosen at runtime is a `Record` over its union, not a template.**
`` `bot.progress.${flow}` `` compiled whatever `BotFlow` gained; `PROGRESS_KEY:
Record<BotFlow, BotKey | null>` does not compile until the new flow has a key
(the F-084 pattern, as `BOT_LINK_MESSAGE_KEY` already did in `auth-service`). A
value that arrives over HTTP (`messageKey`) is looked up in the generated
namespace (`botLinkMessageKey()`), never spliced. `BOT_COPY_FALLBACKS` is keyed
by `BotKeys` and `satisfies Record<BotKey, string>`, so a missing fallback is a
compile error rather than a spec failure.

```check C-07
forbid: (\bkey:\s*|Exception\(\s*)['"][a-z][A-Za-z0-9_]*\.[A-Za-z0-9_.]+['"]
in: txnet-backend/**/*.ts
except: txnet-backend/**/*.spec.ts, txnet-backend/*-e2e/**, txnet-backend/shared-core/src/lib/i18n/**, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**
message: use BackendI18nKeys.<namespace>.* (or BotKeys.* in bot-service) as the key (C-07) — a literal key renders as itself when renamed
```

```check C-07
forbid: ['"]bot\.[a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+['"]
in: txnet-backend/bot-service/src/**/*.ts
except: txnet-backend/bot-service/src/**/*.spec.ts
message: use BotKeys.* from locale/bot-keys (C-07) — a literal bot key renders as itself when renamed
```

```check C-07
forbid: ^(?!\s*(\*|//|/\*)).*(`(bot\.[a-zA-Z.]*|otp\.botLink\.)\$\{|['"]otp\.botLink\.[A-Za-z])
in: txnet-backend/**/*.ts
except: txnet-backend/**/*.spec.ts, txnet-backend/*-e2e/**, txnet-backend/shared-core/src/lib/i18n/**, txnet-backend/bot-service/src/app/locale/bot-keys.ts, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**
message: pick the key from an exhaustive Record over the union, or botLinkMessageKey() for a value from HTTP (C-07) — a spliced key compiles whatever the union gains
```

---

## C-08 — a routing key is declared once, in shared-core

**Rule.** `OutboxEventType.*`, `automationTickRoutingKey()`,
`OTP_DELIVERY_ROUTING_KEY`, `USAGE_DELTA_ROUTING_KEY`, `topicBindingAll(PREFIX)`
and the existing `BOT_UPDATE_ROUTING_PREFIX` / `outboxRoutingKey()` are the only
spellings of a routing key or outbox event type.

**Why.** Publisher and binder are always in different Nx apps (`billing-service`
writes `billing.payment.confirmed`, `worker-service` binds it). A key renamed on
one side still publishes — to no queue — and the only signal is an
`unroutable` confirm. Before this, billing, the worker's binding and both
consumers each spelled the event type by hand.

`network.usage.delta` is the third publisher-binder pair and the first one
that crosses a language: `network-service` writes it in Go and
`billing-service` will bind it (F-027-n). Go cannot import `shared-core`, so
both spellings are held to `contracts/network/delta.json` by a test on each
side — the same answer `capabilities.json` gives, for the same reason
(ADR-0036, C-04).

Some outbox event types are also the `type` of a realtime event the panel reads.
`contracts/realtime/events.json` declares those; `routing-keys.contract.spec.ts`
holds `RealtimeEventType` (the subset of `OutboxEventType` a browser sees) to it and `site-pwa` imports `RealtimeEvents` from the
copy generated from it (`@/generated/wire`).

```check C-08
forbid: ['"](automation\.tick\.|otp\.delivery\.|billing\.payment\.|network\.usage\.)|`(automation\.tick|otp\.delivery|billing\.payment|network\.usage)\.\$\{
in: txnet-backend/**/*.ts
except: txnet-backend/**/*.spec.ts, txnet-backend/*-e2e/**, txnet-backend/shared-core/src/lib/automation/routing-keys.ts, txnet-backend/shared-core/src/lib/automation/usage-delta.ts, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**
message: import the key from shared-core's automation/routing-keys or usage-delta (C-08) — a routing key spelled twice routes to nothing when one side is renamed
```

```check C-08
forbid: ["'`]billing\.payment\.
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx
except: site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx, site-pwa/src/generated/**
message: import RealtimeEvents from @/generated/wire (C-08) — generated from contracts/realtime/events.json
```

---

## C-09 — a closed set of values is declared once

**Rule.** A zod schema for a value from a closed set derives from its one
declaration: `z.nativeEnum(SocialPlatform)` for a Prisma enum, or
`z.enum(GATEWAY_CREDENTIAL_SOURCES)` for an `as const` tuple whose type is
`(typeof X)[number]`. A TypeScript union of the same values derives too
(`'sms' | BotPlatform`), never restates them.

**Why.** `z.enum(['telegram', 'bale'])` was written four times in one file,
beside `BotPlatform` in `messenger` and `SocialPlatform` in Prisma. A value
added to the enum is then refused at the HTTP edge with a 400 and nothing
compiles red. `env.validation.ts` is excepted: its sets (`'true' | 'false'`,
`NODE_ENV`) belong to that file alone.

```check C-09
forbid: z\.enum\(\s*\[
in: txnet-backend/**/*.ts
except: txnet-backend/**/*.spec.ts, txnet-backend/**/env.validation.ts, txnet-backend/*-e2e/**, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**
message: derive the schema from the enum or as-const tuple (C-09) — z.nativeEnum(PrismaEnum) or z.enum(TUPLE)
```

---

## C-10 — a panel route comes from `lib/routes.ts`

**Rule.** Every navigation target in `site-pwa` — `href`, `redirect()`,
`router.push/replace()` — is a constant from `@/lib/routes`.

**Why.** `AUTH_REGISTER` exists because `/auth/signup` was spelled at each call
site and a rename missed one (see `proxy.ts`). `/auth/login` and
`/auth/forgot-password` were still literals in three files. `RENAMED_PATH` in
`proxy.ts` stays a literal on purpose: it is the old path, not a route.

```check C-10
forbid: (href=|redirect\(|router\.(push|replace)\()\s*\{?\s*["'`]/[a-z]
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx
except: site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx
message: import the path from @/lib/routes (C-10) — a route spelled at the call site is missed by the next rename
```

## C-11 — an app with a tenant registers `TenantStatusGuard`

**Rule.** A Nest app under `txnet-backend/` that calls `runWithTenant(...)`
anywhere registers `{ provide: APP_GUARD, useClass: TenantStatusGuard }` and
binds `TENANT_STATUS_STORE`. A route then labels what it does with
`@TenantCapability`; a mutating route that labels nothing is `staffWrite`.

**Why.** The guard is opt-in per app. F-018-f registered it in `auth-service`
and `billing-service`, and `notification-service`'s campaign admin stayed open
to a suspended reseller until F-018-p — nobody forgot a rule, the rule simply
had no place to fail. Background work is not an HTTP route: a tick that names a
tenant is judged by `worker-service`'s `TenantStatusGate` instead.

**`metering-service` is excepted** (F-027-n, user's decision 2026-09-21). It
serves no route, so there is nothing for the guard to judge, and it opens a
tenant scope for one purpose: `traffic_raw_log` and `grant` carry RLS policies
keyed on `app.tenant_id`, so the scope is the label on a row rather than
permission to write it. Judging a pass by tenant status would mean **not
recording a suspended reseller's measured traffic**, and that figure is read
from a panel once: dropping it loses bytes permanently, which is network
invariant 18 and the failure ADR-0074 exists to prevent. Recording is not
charging — `consumedBytes` is the measured cursor, not the money one. The day
this service grows a route, the guard is that row's decision again.

```check C-11
require: provide:\s*APP_GUARD,\s*useClass:\s*TenantStatusGuard\b
per: txnet-backend/*
when: \brunWithTenant\([^)]
in: txnet-backend/*/src/**/*.ts
except: txnet-backend/shared-core/**, txnet-backend/**/*.spec.ts, txnet-backend/metering-service/**
message: register TenantStatusGuard as an APP_GUARD in this app (C-11) — a route here serves a tenant and no status judges it
```

## C-12 — a route wildcard has a name

**Rule.** In `forRoutes(...)`, `exclude(...)`, a route decorator, or a
`*_ROUTE(S)` / `*_PATH` constant, a wildcard is written the way
path-to-regexp 8 (Express 5, Nest 11) reads it: `*name` for one or more
segments, `{*name}` for zero or more. `forRoutes('{*path}')` is "every route".

**Why.** Nest 11 still accepts the old bare `*`, but only by rewriting it at
boot, with a `LegacyRouteConverter` warning. These patterns are where the
identity, language and tenant middleware attach. If a release drops the
rewrite, a bare `*` matches nothing, and the middleware stops running without
an error: routes lose their identity check or their tenant scope. On
2026-09-18, four services carried seven of them (fixed in `d621388` and
`d9c917d`).

```check C-12
forbid: (?:\b(?:forRoutes|exclude)\(|@(?:Get|Post|Put|Patch|Delete|All|Options|Head|Controller)\(|\b[A-Z_]*(?:ROUTE|ROUTES|PATH)\s*=\s*)[^;]*['"`][^'"`\s]*(?<!\{)\*(?=['"`/])
in: txnet-backend/*/src/**/*.ts
except: txnet-backend/**/*.spec.ts
message: name the wildcard (C-12) — `'{*path}'` for every route, `'prefix/*path'` under a prefix; a bare `*` is only auto-converted by Nest 11 and matches nothing once that stops
```
