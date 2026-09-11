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
| C-02 | Money is base-currency `Decimal` only — never a second currency column, never written as a float. Balances are ledger-derived; never write a balance field directly outside a ledger-append transaction. See ADR-0002. | review |
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
base currency. No monetary table gets its own currency column. A wallet-style
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
declare. Neither crosses a boundary this contract owns. `site-pwa` is outside
the check for a third reason: it is not in the Nx workspace and has no path to
`shared-core`, so there is nothing for it to import — see
`docs/platform/forward-auth/open-questions.md`.

```check C-04
forbid: ['"]x-[a-z0-9]+(-[a-z0-9]+)+['"]
in: txnet-backend/**/*.ts
except: txnet-backend/shared-core/src/lib/http/**, txnet-backend/**/*.spec.ts, txnet-backend/worker-service/src/app/broker/broker.service.ts, txnet-backend/bot-service/src/app/webhook/webhook.controller.ts
message: import the name from shared-core/src/lib/http (C-04) — a header spelled twice is the drift ADR-0036 exists to stop
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
