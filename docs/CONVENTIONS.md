---
id: conventions
status: active
updated: 2026-09-04
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
| C-03 | Redis keys are built only through `RedisKeys.*` (`redis.keys.ts`) or the matching `auth-handler` config — nothing else hand-writes a key string. Every key is prefixed `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`. See `docs/platform/redis-keyspace/contract.md`. | check |

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

```check C-03
forbid: redis\.(get|set|del|expire|incr|decr|hset|hget|hdel|sadd|srem|exists)\(\s*`
in: txnet-backend/**/*.ts
except: txnet-backend/**/redis.keys.ts, txnet-backend/**/*.spec.ts
message: build the key through RedisKeys.* (redis.keys.ts) — never a raw template-literal key (C-03)
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
