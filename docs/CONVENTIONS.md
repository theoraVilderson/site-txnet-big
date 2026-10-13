---
id: conventions
status: active
updated: 2026-10-13
---

# House style

Rules about **how code is written**, as opposed to what it does. Business rules
live in a unit's `rules.md`; those are about the product. These are about the
codebase, and they apply everywhere.

Read at tier 4 — before writing code inside any unit.

## The short version — read this before any code

Every session reads this block whole; the sections below are looked up by id
(`grep -n "## C-27" docs/CONVENTIONS.md`), not read through. Each line names
the rule that holds it. **check** = `conventions.py` or `codeshape.py` fails on
it; the rest is review.

**Before writing**
- Look for the home first: the need probably has one already (C-27 table).
  The second copy of anything is an extraction, never a paste.
- A new dependency, a new pattern or a new shared module is a question to the
  user, not a decision made mid-item (C-34, AGENTS.md "Decide once").
- The spec comes first and fails for the reason you named (CODE-LAYOUT.md).

**Names and shape**
- Names say what a thing is in the product's words; units in the name
  (`timeoutMs`, `amountMinor`); booleans read as questions (`isOwner`) — C-23.
- A function does one thing, ≤ ~50 lines, ≤ 3 positional parameters, nesting ≤ 3,
  no boolean flag parameters, no nested ternaries — C-35.
- A file ≤ 400 lines, a React file ≤ 10 `useState`; split by job — C-20 **check**.
- A comment says why and cites its id; every export of a lib module has one doc
  line; no commented-out code; English only — C-22, C-01 **check**.

**Nothing hardcoded, nothing repeated**
- No language literal (C-17), no domain literal compared at a call site (C-18),
  no user text in code (C-19), no magic number (C-22), no closed set restated
  (C-09), no route / header / Redis key / routing key spelled by hand
  (C-10, C-04, C-03, C-08) — all **check**.
- Pasted blocks, dead files, dead exports and unused packages fail `codeshape.py`
  — C-27, C-21 **check**. What a change replaces, it deletes.

**Correctness — the bugs nobody sees**
- Types are honest: no `any`, no `as unknown as`, no `!`, no `@ts-ignore`;
  input from outside is parsed with zod at the edge; a `switch` over a union is
  exhaustive — C-24 **check** (backend: `npm run lint`).
- An error is handled once, on purpose: no empty `catch`, no swallowed promise,
  a user-facing failure is a locale key — C-25 **check** (backend: `npm run lint`).
- Money is `Decimal`/string in its currency, never a float (C-02 **check**);
  time is UTC on the wire and in the database, zoned only at the edge (C-37).
- A write that can run twice runs safely twice; a multi-row change is one
  short transaction with no outside call inside it, locking rows in one
  order; tenant data goes through `tenantTransaction` — C-29.
- Go: every goroutine can be stopped and is waited for, fan-out is bounded,
  shared state has one guard, `-race` runs on it — C-36.
- Config is read from the app's validated env module only — C-26 **check**.

**Fast by default**
- No query inside a loop; every list is paged with a maximum; select what you
  render; a new filter on a growing table ships its index — C-28.
- Slow or retried work goes to the queue; every outside call has a timeout —
  C-28. A page hears queued work over the socket, never polls — C-14 **check**.
- React: derive, do not mirror state; effects only sync with the outside; keys
  are ids — C-30 **check**. Styling is tokens and logical sides — C-31 **check**.

**Changes that do not break what is running**
- An API, a queue message and an outbox event only gain fields; a renamed
  meaning is a new name — C-37.
- A schema change is expand, migrate, contract; a drop carries
  `-- contract: <row id>`; a committed migration is never edited — C-39 **check**.

**Every reader**
- Kit primitives or native `button`/`a`, never a clickable `div`; `alt` on
  every image; `aria-label` on icon-only controls; never colour alone — C-40
  **check**.

**Safe by default**
- Authorise on the server for every route; the UI hiding a button is not
  security. No raw unsafe SQL, no `dangerouslySetInnerHTML`, no secret in code,
  no token or phone number in a log — C-32 **check**, C-38.
- Lockfiles are committed; a critical advisory in a dependency is its own row,
  ahead of features (the 2026-09 compromise was one) — C-34.

**Done**
- The seven checks in AGENTS.md pass; a debt entry you touched got smaller and
  `codeshape.py --tighten` locked it in (C-20).

## The format

Every convention gets a permanent id (`C-nn`), cited in review and in commit
messages the same way a catalog id is. The `enforced by` column is the honest
part of this file: it shows at a glance which rules are actually held and which
ones are only hoped for.

| enforced by | means |
|---|---|
| `check` | `tools/conventions.py` fails on a violation (a ```` ```check ```` block in the rule's section), or `tools/codeshape.py` fails when a per-file count grows past its baseline |
| `lint` | a linter fails on it (rule named in the section). `site-pwa` runs ESLint; `txnet-backend` has no linter today |
| `review` | nothing enforces it. It will be violated eventually. |

A convention that keeps getting violated does not need a firmer sentence. It
needs to move up that table.

**Ids are permanent.** A rule is never renumbered or reused; a rule that is
retired keeps its row, marked `retired — <why>`, so every commit and review
that cites it still resolves. A new rule takes the next free number and is
added in four places in one change: its row in the table below (the one line
`tools/brief.py` prints), its section, a line in "The short version", and its
check block if a regex can hold it. An `except:` entry that is debt names the
row that removes it; one that is permanent says why in the section.

## Conventions

| id | rule | enforced by |
|---|---|---|
| C-01 | Technical docs, code, commit messages and logs are in English. A Persian comment is a violation; the files that still hold one are listed in the check and leave with FE-1-f / CS-1-e. | check |
| C-02 | Money is `Decimal`, never a float, and every money row records its `currencyCode` (ADR-0098) — one currency per row, never a second amount column in another. A payment's gateway receipt, `amountReceivedMinor` + `receivedCurrency` (D-32), is evidence, not money of record. Balances are ledger-derived; never write a balance field directly outside a ledger-append transaction. See ADR-0002. | check |
| C-03 | Redis keys are built only through `RedisKeys.*` (`shared-core/src/lib/redis/keys.ts`, re-exported per app) or `cache.SessionKey` in Go — nothing else hand-writes a key string. Every key is prefixed `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`. See `docs/platform/redis-keyspace/contract.md`. | check |
| C-04 | A header, cookie or permission name that crosses a process boundary is declared in `contracts/http/wire.json` and imported from `shared-core/src/lib/http/` (TypeScript) or `auth-handler/internal/api/handlers/headers.go` (Go). Nothing else writes one as a literal. See ADR-0036. | check |
| C-05 | A rate-limit bucket is a `RateLimitBucket` registry entry joined with `rateLimitBucketKey()`. A bare string where a bucket belongs is a violation. See ADR-0036. | check |
| C-06 | An i18n key in the panel is referenced through the generated constants (`site-pwa/src/generated/i18n-keys.ts`). A bare string literal as the key of a `t(...)` call is a violation. Keys built by concatenation are F-084's exhaustive maps, not literals. See ADR-0036. | check |
| C-07 | A backend i18n key is a generated constant — `BackendI18nKeys.*`, or `BotKeys.*` in `bot-service`. A literal key in `key:` or an exception constructor is a violation, and so is a key spliced from a template: a key chosen at runtime comes from an exhaustive `Record` over its union. See ADR-0036. | check |
| C-08 | A broker routing key or outbox event type is imported from `shared-core/src/lib/automation/routing-keys.ts` (or `bot-update.ts` / `outbox.ts`). Nothing else spells one. | check |
| C-09 | A closed set of wire values is declared once — a Prisma enum (`z.nativeEnum`) or an `as const` tuple beside its type — and a zod schema derives from it. A hand-written `z.enum([...])` is a violation (env validation excepted). | check |
| C-10 | A panel route is a constant in `site-pwa/src/lib/routes.ts`. A path literal in `href=`, `redirect(` or `router.push/replace(` is a violation. | check |
| C-11 | A backend app that opens a tenant scope (`runWithTenant(...)`) registers `TenantStatusGuard` as an `APP_GUARD`, so every route it serves obeys `TenantStatusPolicy`. See `docs/domains/tenant/rules.md`. | check |
| C-12 | A Nest route or middleware path names its wildcard: `'{*path}'`, `'internal/*path'`, `@Get('*key')`. A bare `*` — `forRoutes('*')`, `'internal/*'` — is a violation. | check |
| C-13 | A panel control is a kit primitive (`(panel)/_components/kit`, `contract.ux.md` K3–K14). Under `site-pwa/src/app/(panel)/`, outside the kit, `window.confirm(` (use `useConfirm`), a local button or input class constant (`primaryButton`, `quietButton`, `secondaryButton`, `dangerButton`, `input`, `inputClass`, `PRIMARY`, `SECONDARY`, `INPUT`) and `text-white` beside `bg-primary` (use `text-on-accent`) are violations. | check |
| C-14 | A page never polls the server for state that someone else's work changes — it subscribes and re-reads (`useLiveReread`, ADR-0121). Under `site-pwa/src/app/` and `site-pwa/src/hooks/`, a `setInterval(` is a violation unless it is a clock (`setNow(`, `setSeconds(`) or carries a `live-exempt: <reason>` comment on its line. | check |
| C-15 | Who holds a key is asked of `findKeyHolders` (shared-core, ADR-0138) — a role, a key given, a group of the tenant, less a key taken. A Prisma filter on `rolePermissions: { some: { permission: ... } }` outside it is a violation: it misses a key given to one person and tells someone it was taken from. | check |
| C-16 | Code asks what a tenant may do — a feature key or a limit — never which package it bought (catalog §3.11). | check |
| C-17 | A language is never a literal. The languages offered come from the locale meta (`availableLocales`, `locale-service`); the fallback is `DEFAULT_LANGUAGE`, read in one place per app; a machine locale used only to format or parse digits is a named constant. | check |
| C-18 | A domain question is one named function: *is this the platform's tenant*, *may this user buy* — asked of the module that owns the type, never re-derived from a literal at the call site. `"platform_owner"` outside its owners is a violation. | check |
| C-19 | Text a person reads is never in code: it is a locale key (C-06, C-07). Arabic-script literals live only in a module whose job is the script itself — normalising digits and letters, transliterating, matching. | check |
| C-20 | A source file is at most 400 lines and a React file declares at most 10 `useState` (`tools/codeshape.py`). Files over it today are a baseline that may only shrink. | check |
| C-21 | Code that is replaced is deleted in the same change, with its tests and its doc mentions. No file or export only tests reach, no `dependencies` entry nothing imports (`codeshape.py` `dead`/`exports`/`deps`), no `console.log`/`console.debug` in app code, no `TODO`/`FIXME` without a backlog id: `TODO(FE-1-e)`. | check |
| C-22 | A comment says *why* — the rule, the case or the id it comes from — never what the next line plainly does. Every export of a `lib/`, `_lib/` or service module has a one-line doc. No commented-out code. A file does one job: a page is thin, its view is in `_components`, its state in `_hooks`, its pure logic in `_lib`; a controller is thin over a service. | review |
| C-23 | A name says what the thing is, in the product's words (`grant`, `tenant`, `panel`, not `data`, `info`, `item2`); it carries its unit (`timeoutMs`, `sizeBytes`, `amountMinor`); a boolean reads as a question (`isOwner`, `hasGrant`, `canBuy`). TypeScript: `camelCase` values, `PascalCase` types and components, `UPPER_SNAKE` module constants, files `kebab-case.ts`, components `PascalCase.tsx`, hooks `useThing.ts`. No `var`. | check |
| C-24 | Types are honest: no `any`, no `as unknown as`, no non-null `!`, no `@ts-ignore`/`@ts-nocheck`. Outside input is `unknown` until zod parses it; a `switch` over a union ends in `assertNever`. | check |
| C-25 | An error is handled once and on purpose: no empty `catch`, a caught error is converted, rethrown or logged with context — never dropped; a promise is awaited or marked `void` with a reason; what the user reads is a locale key. | check |
| C-26 | Config is read only in the app's validated env module (`env.validation.ts`, `site-pwa/src/env.ts`); everything else imports the typed value. | check |
| C-27 | One home per need (the table in C-27). The second copy is extracted, not pasted: `codeshape.py` `dupes` fails on a pasted block, `smells` on a bypassed home (`raw-fetch`, `raw-storage`). | check |
| C-28 | Data access is bounded: no query per loop iteration, every list paged with a maximum, select what is used, an index ships with a new filter or sort on a growing table, slow work goes to a queue, every outside call has a timeout and a capped retry, every cache key a TTL. | review |
| C-29 | A write that may run twice is safe twice (a dedupe key or a unique constraint); a change across rows is one transaction; read-modify-write is a conditional update; tenant data goes through `tenantTransaction`/`withTenant`; an event leaves through the outbox; a transaction makes no outside call and locks rows in one order. | review |
| C-30 | React renders from minimal state: derive instead of mirroring, an effect only syncs with something outside React and cleans up, list keys are ids, an `eslint-disable` says why after ` -- `. Server components by default; heavy client code is a dynamic import. | check |
| C-31 | Panel styling is theme tokens and logical sides: no hex colour in a component, no `ml-`/`mr-`/`left-`/`text-left`, so RTL and LTR both work; contrast per `contract.ux.md`. | check |
| C-32 | Every route authorises on the server; input is validated at the edge; no `$queryRawUnsafe`/`$executeRawUnsafe`, no `dangerouslySetInnerHTML` (the theme scripts excepted), no `eval`, no key material in code, no `Math.random` in the backend. | check |
| C-33 | A bug fix starts with a spec that fails on the bug. Specs test behaviour through the public surface, use fake timers not sleeps, and never ship `.only` / `.skip`. | check |
| C-34 | One library per job. A new dependency is asked for first, with what it replaces and its size; an unused one is removed (`codeshape.py` `deps`). Lockfiles are committed; a critical advisory is its own row, ahead of feature work. | check |
| C-35 | A function does one thing: about 50 lines at most, at most 3 positional parameters (more is an options object), nesting at most 3 (return early), no boolean flag parameter, no nested ternary. | review |
| C-36 | Go: `gofmt`/`go vet` clean; `context.Context` is the first parameter of anything that does I/O; errors are wrapped with `%w` and returned, not logged and dropped; `panic` only for a broken invariant, with its reason; every goroutine is stoppable and waited for, fan-out is bounded, shared state has one guard and `-race` runs on it. | review |
| C-37 | An API change is backwards compatible until every consumer moved: add a field, never rename or retype one in place — queue messages and outbox events included; the unit's `contract.md` changes in the same commit. Time is ISO-8601 UTC on the wire and in the database, zoned only for display (`_lib/datetime.ts`, `shared-core/lib/time`). | review |
| C-38 | A log line says what happened, to which ids, at the right level, through the app's logger (Nest `Logger` with the class name; `console.info`/`warn`/`error` in Next server code). Never a token, password, OTP, card or full phone number. | review |
| C-39 | A schema change ships in steps: add, move every reader and writer, then remove. A destructive statement (drop, rename, retype) carries `-- contract: <row id>` naming the row that moved the readers; an applied migration is never edited; a new tenant table gets its RLS policy in the same migration. | check |
| C-40 | A screen works for every reader: controls are kit primitives or native `button`/`a` (never a clickable `div`), an icon-only control has an `aria-label`, an image has `alt` (`""` when decorative), state is never shown by colour alone, motion honours reduced motion. | check |

---

## C-01 — English only

**Rule.** Docs, code, commit messages and logs are written in English,
comments included.

**Why.** A polyglot backend (Go + TypeScript) already forces contributors to
context-switch between two languages; mixing in a third for comments makes
`git blame` and code review slower for the next person, whoever they are.

Three Arabic-script words in a row inside a comment is prose, not a quoted
example (`"۱۲۳"`, `ی`), so that is what the check matches. The files in
`except` held such comments on 2026-10-13 and leave with FE-1-f (panel) and
CS-1-e (backend, Go); a new one is refused.

```check C-01
forbid: (//|/\*|^\s*\*|\{/\*).*[\u0600-\u06FF]{2,}\s+[\u0600-\u06FF]{2,}\s+[\u0600-\u06FF]{2,}
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx, txnet-backend/**/*.ts, auth-handler/**/*.go, i18n-platform/**/*.go, network-service/**/*.go, sub-service/**/*.go
except: site-pwa/src/generated/**, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**, txnet-backend/.devin/**, txnet-backend/**/generated/**, **/*.pb.go, coinsite/src/app/(Auth)/login/page.tsx, coinsite/src/util/theme.ts, site-pwa/src/app/(auth)/auth/_components/AuthCardShell.tsx, site-pwa/src/app/(auth)/auth/_components/PasswordField.tsx, site-pwa/src/app/(auth)/auth/_components/ThemeDropdown.tsx, site-pwa/src/app/(auth)/auth/_hooks/useFirstPaint.ts, site-pwa/src/app/(auth)/auth/loading.tsx, site-pwa/src/app/(panel)/_lib/money.ts, site-pwa/src/app/layout.tsx, site-pwa/src/context/LocaleContext.tsx, site-pwa/src/context/LocaleShell.tsx, site-pwa/src/context/ThemeContext.tsx, site-pwa/src/env.ts, site-pwa/src/instrumentation.ts, site-pwa/src/lib/locale-store.ts, site-pwa/src/lib/theme-script.ts, site-pwa/src/services/locale.ts, site-pwa/src/services/theme.ts, site-pwa/src/services/user-locale-mock.ts, site-pwa/src/stores/locale-store.ts, site-pwa/src/stores/theme-store.ts, txnet-backend/auth-service/src/app/auth/auth.schema.ts, txnet-backend/auth-service/src/app/impersonation/impersonation.module.ts, txnet-backend/messenger/src/lib/capabilities.ts, txnet-backend/shared-core/src/lib/sms/sms-provider.service.ts, txnet-backend/tenant-service/src/app/guide/guide-search.spec.ts
message: write the comment in English (C-01)
```

## C-02 — money is `Decimal` in its row's currency, balances are ledger-derived

**Rule.** A monetary value is stored once, as `Decimal`, and its row records the
currency it is in: `currencyCode`, NOT NULL with no default, so a writer names it
(ADR-0098 part 3, amending ADR-0002's single base currency). A row's currency is
never derived from its tenant, whose currency may change. A ledger row is in its
wallet's currency. `payment_transaction`'s gateway receipt (`amountReceivedMinor` + `receivedCurrency`, D-32) is evidence of what arrived, never credited as is — `amountCredited` is in the row's `currencyCode`. A wallet-style
`cachedBalance` is never written outside the same transaction that appends the
proving ledger row.

**Why.** Storing an amount in more than one currency, or trusting a cached
balance as truth, guarantees the two copies drift — and the drift is discovered
as a refund or a payout that does not reconcile, usually months later. See
ADR-0002 for the full reasoning and the units it binds.

**Half of it is a check.** A float is the one money bug a regex can see: a
money-named column declared `Float`, or `parseFloat` in backend code (an amount
is read with `new Decimal(x)`; an integer of minor units is `BigInt`, which is
not a float). None existed on 2026-10-13, so the check holds that. Whether a
`cachedBalance` was written inside its ledger transaction needs the
transaction boundary, not a regex — that half stays in review.

```check C-02
forbid: ^\s*\w*([Aa]mount|[Pp]rice|[Bb]alance|[Cc]ost|[Ff]ee)\w*\s+Float\b
in: txnet-backend/prisma/domains/*.prisma
message: store money as Decimal with its currencyCode, or BigInt minor units — never Float (C-02, ADR-0002)
```

```check C-02
forbid: \bparseFloat\(
in: txnet-backend/*/src/**/*.ts
except: txnet-backend/**/*.spec.ts
message: read a number as Decimal (money) or Number.parseInt / Number (counts) — a float rounds money silently (C-02)
```

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

**Two check blocks, one per language.** The Go gateway once concatenated
`h.keyPrefix + "session:" + id` inline, where the TypeScript-only check could
not see it; F-076 built `internal/cache/keys.go` and the second block keeps it
the only builder. Specs are not excepted: they are the files most likely to
hand-write a key while asserting one.

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

**Some files stay in `except:` permanently, and they are not debt.**
`webhook.controller.ts` spells
`x-telegram-bot-api-secret-token`, which is Telegram's name and not ours to
declare, on a boundary this contract does not own. The payment drivers
(`payment/gateway/*.provider.ts`) are the same case: `x-nowpayments-sig` and
`x-api-key` are a provider's names on its own wire (F-104-h). RabbitMQ's own
queue arguments (`x-dead-letter-exchange`, `x-message-ttl`, …) are not names
on a wire this contract owns either; the pattern skips them by prefix, so a
new queue file needs no `except:` line. `site-pwa` is not in
the Nx workspace and cannot import `shared-core`; it imports the same names
from `@/generated/wire`, which `tools/wire-gen.py` writes from `contracts/` and
`tools/contracts.py` fails on when stale (ADR-0036 amendment 2026-09-14). The
second check block below holds it to that.

```check C-04
forbid: ['"](?!x-dead-letter-|x-message-ttl|x-max-|x-queue-|x-single-active-consumer)x-[a-z0-9]+(-[a-z0-9]+)+['"]
in: txnet-backend/**/*.ts
except: txnet-backend/shared-core/src/lib/http/**, txnet-backend/**/*.spec.ts, txnet-backend/bot-service/src/app/webhook/webhook.controller.ts, txnet-backend/billing-service/src/app/payment/gateway/*.provider.ts
message: import the name from shared-core/src/lib/http (C-04) — a header spelled twice is the drift ADR-0036 exists to stop
```

```check C-04
forbid: ["'](x-[a-z0-9]+(-[a-z0-9]+)+|X-[A-Za-z0-9]+(-[A-Za-z0-9]+)+|refresh_token)["']
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx
except: site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx, site-pwa/src/generated/**
message: import the name from @/generated/wire (C-04) — it is generated from contracts/http/wire.json; add a name there, then run python3 tools/wire-gen.py
```

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

## C-06 — a panel i18n key comes from the generated constants

**Rule.** In `site-pwa`, the key passed to `t(namespace, key)` is a generated
constant — `t("common", C.accounts.add)` where `C = FrontendI18nKeys.common` —
never a string literal.

**Why.** Both locale clients return the key itself when it is missing and never
throw, so a typo or a key renamed in `locales/` renders as a raw dot path on a
real screen with every suite green. A generated constant turns that into a
compile error at the call site.

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

## C-13 — a panel control is a kit primitive

**Rule.** Inside `site-pwa/src/app/(panel)/`, a button is the kit `Button` /
`IconButton` (a link that looks like one takes `buttonClass()`), a text box is
the kit `Input` / `Textarea` / `Select` / `NativeSelect` in a `Field`, and a
question is `useConfirm()`. A primary surface carries `text-on-accent`.

**Why.** Before UX-1 the panel had 578 hand-rolled `<button>`s, 24 local input
class constants, four different `primaryButton` strings and 26
`window.confirm`s, so one fix (a focus ring, a disabled state, the dark
theme's light-green accent) had to be made in every copy and was not.
`text-white` on `bg-primary` fails contrast in the dark theme, where the
accent is light (`contract.ux.md` K1). UX-1-ab … UX-1-ae moved every area onto
the kit; this check keeps the three patterns that would bring the copies back
from returning. A control the kit has no primitive for (a choice card, a row
that is itself a button) is still written by hand, with theme tokens —
`contract.ux.md` R1.

```check C-13
forbid: window\.confirm\(|^\s*(?:export\s+)?const\s+(?:primaryButton|quietButton|secondaryButton|dangerButton|input|inputClass|PRIMARY|SECONDARY|INPUT)\s*=\s*(?:["'`]|$)|\bbg-primary(?![\w-])[^"'`]*\btext-white\b|\btext-white\b[^"'`]*\bbg-primary(?![\w-])
in: site-pwa/src/app/(panel)/**/*.tsx, site-pwa/src/app/(panel)/**/*.ts
except: site-pwa/src/app/(panel)/_components/kit/**, site-pwa/src/app/(panel)/**/*.test.tsx, site-pwa/src/app/(panel)/**/*.test.ts
message: use the kit (C-13) — useConfirm for a question, Button / Input / buttonClass for a control, text-on-accent on a primary surface (contract.ux.md K3–K14, E1)
```

## C-14 — a page hears queued work, it does not poll for it

**Rule.** A page learns that a job, a worker tick or another service changed
something by its event on `user:` or `tenant:`, through `useLiveReread`, and
re-reads the API. It still reads on mount. A timer is a clock, a beat the page
*sends*, or marked `// live-exempt: <reason>` on the same line.

**Why.** On 2026-10-06 six pages polled — payment pending, bulk jobs, the
support inbox, menu badges, bot linking, the locale version — and two more
waited for a click, each built before its producer had an event (ADR-0121).
The socket, the fan-out and the outbox wake already existed; nothing stopped
the next page from polling. Each file in `except` is a poller with an open
`RT-1` row and leaves the list when its row lands. A producer that changes
visible state owes the event — ADR-0121 point 2; this check sees only the
page's half, and only `setInterval`, not a `setTimeout` that re-arms itself.

```check C-14
forbid: \bsetInterval\((?!.*\bset(?:Now|Seconds)\()(?!.*live-exempt:)
in: site-pwa/src/app/**/*.ts, site-pwa/src/app/**/*.tsx, site-pwa/src/hooks/**/*.ts, site-pwa/src/hooks/**/*.tsx
except: site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx, site-pwa/src/app/(panel)/_hooks/useMenuBadges.ts, site-pwa/src/app/(panel)/payment/_components/PaymentPendingView.tsx, site-pwa/src/app/(panel)/support/_components/SupportInboxView.tsx, site-pwa/src/app/(panel)/my-resellers/*/users/_components/BulkByFilter.tsx, site-pwa/src/app/(auth)/auth/_hooks/useBotLink.ts
message: subscribe and re-read with useLiveReread (C-14, ADR-0121); the producer owes an outbox event — a clock or a beat the page sends is marked `// live-exempt: <reason>`
```

## C-15 — who holds a key is one question

**Rule.** A query that picks people by a key — who to tell, who to list —
calls `findKeyHolders(tx, tenantId, key, where)`. Checking one caller's own
token stays `holdsPermission`.

**Why.** ADR-0138 made a person's keys their role's, plus keys given and a
group's, minus keys taken. On 2026-10-09 the wheel's 80% alert still read role
rows alone, so a person given `engagement.manage` was never told and a person
it was taken from still was. The rule is `accessOf`'s for one key, written
once as a query.

```check C-15
forbid: rolePermissions:\s*\{\s*some:\s*\{\s*permission:
in: txnet-backend/**/*.ts
except: txnet-backend/**/*.spec.ts, txnet-backend/shared-core/src/lib/http/key-holders.ts
message: ask findKeyHolders (shared-core, C-15, ADR-0138) — role rows alone miss a key given or taken, and a group's
```

## C-16 — a package is never asked for by name

**Rule.** Code asks what a tenant *may do* — a feature key or a limit — never
*which package it bought*. `tenant.plan === 'pro'`, `pkg.name !== 'Starter'`,
`switch (package.name)`, `where: { package: { name: 'Growth' } }` are all
violations; reading a package's name to show it is not.

**Why.** Catalog §3.11: a name check makes "the Pro plan but with 20 domains"
a deploy instead of a panel edit, and spreads the package's definition over
every file that tests it. The package's keys and limits (`contract.limits.md`,
`contract.entitlements.md`) are the only place a package means anything. On
2026-10-09 nothing violated it; this keeps it that way. The pattern covers
`plan`, `package`, `pkg` and `*Plan` / `*Package` names in TypeScript and Go.

```check C-16
forbid: (?:(?:\b(?:plan|package|pkg)|[a-z0-9.](?:Plan|Package))(?:Name|Slug|Code)?(?:\??\.(?:[Nn]ame|[Ss]lug|[Cc]ode))?\s*[!=]==?\s*['\"`]|['\"`]\s*[!=]==?\s*[\w?.]*(?:\b(?:plan|package|pkg)|[a-z0-9.](?:Plan|Package))(?:Name|Slug|Code)?(?:\??\.(?:[Nn]ame|[Ss]lug|[Cc]ode))?\b(?!\s*\()|switch\s*\(\s*[\w?.]*(?:\b(?:plan|package|pkg)|[a-z0-9.](?:Plan|Package))(?:Name|Slug|Code)?(?:\??\.(?:[Nn]ame|[Ss]lug|[Cc]ode))?\s*\)|\.includes\(\s*[\w?.]*(?:\b(?:plan|package|pkg)|[a-z0-9.](?:Plan|Package))(?:Name|Slug|Code)?(?:\??\.(?:[Nn]ame|[Ss]lug|[Cc]ode))?\s*\)|\b\w*(?:[Pp]ackage|[Pp]lan)\w*\s*:\s*\{\s*(?:name|slug|code)\s*:\s*['\"`]|[Pp]ackage\.find\w*\(\s*\{\s*where\s*:\s*\{\s*(?:name|slug|code)\s*:\s*['\"`])
in: txnet-backend/**/*.ts, site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, auth-handler/**/*.go, network-service/**/*.go, sub-service/**/*.go, i18n-platform/**/*.go
except: txnet-backend/**/*.spec.ts, txnet-backend/**/seed*.ts, txnet-backend/prisma/**, site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx, **/*_test.go
message: gate on a feature key (@RequiresFeature / TenantEntitlements.check) or a limit (resellerLimitOf) — never on a package or plan name (C-16, catalog §3.11)
```

## C-17 — a language is never a literal

**Rule.** No `"fa"` or `"en"` in code. The set of languages comes from where it
is decided — the panel's `availableLocales` (locale meta), `locale-service` in
the backend. A request's fallback is `DEFAULT_LANGUAGE`, read once per app
(`site-pwa/src/env.ts`, each service's `env.validation.ts`). A locale chosen to
format or parse digits, not to speak to a person, is a named constant beside
the formatter (`MACHINE_LOCALE`), never an inline `"en"`.

**Why.** The platform sells to resellers in more than one market. On 2026-10-13
the guides editor and the support categories offered exactly `["fa", "en"]`,
and ten backend controllers answered `?? 'fa'` instead of the configured
default — a third language would have been a hunt through 33 files. `except`
lists those files today; each leaves with its row (FE-1-b, CS-1-a, CS-1-b).
`localeCompare` and `Intl.DisplayNames` lines are skipped: there the locale
sorts or names, it does not choose a language.

```check C-17
forbid: ^(?!.*(?:localeCompare|DisplayNames)).*['"`](?:fa|en)['"`]
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx, txnet-backend/**/*.ts
except: site-pwa/src/generated/**, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**, txnet-backend/.devin/**, txnet-backend/**/generated/**, **/*.spec.ts, **/*.test.ts, **/*.test.tsx, txnet-backend/*-e2e/**, txnet-backend/**/env.validation.ts, site-pwa/src/env.ts, coinsite/src/env.ts, site-pwa/src/app/(panel)/_components/CommandPalette.tsx, site-pwa/src/app/(panel)/_components/ImpersonationBanner.tsx, site-pwa/src/app/(panel)/_components/dashboard/widgets/UsersWidget.tsx, site-pwa/src/app/(panel)/_components/guide/GuideList.tsx, site-pwa/src/app/(panel)/_lib/datetime.ts, site-pwa/src/app/(panel)/_lib/money.ts, site-pwa/src/app/(panel)/financial/deposit/_components/AmountInput.tsx, site-pwa/src/app/(panel)/guides/_components/GuideEditor.tsx, site-pwa/src/app/(panel)/guides/_components/GuidesView.tsx, site-pwa/src/app/(panel)/guides/_lib/guides.ts, site-pwa/src/app/(panel)/my-resellers/[id]/users/[userId]/_components/GrantActions.tsx, site-pwa/src/app/(panel)/support/_components/SupportSettingsView.tsx, site-pwa/src/lib/guide-api.ts, site-pwa/src/services/user-locale-mock.ts, txnet-backend/auth-service/src/app/account-switch/account-switch.controller.ts, txnet-backend/auth-service/src/app/auth/auth.controller.ts, txnet-backend/auth-service/src/app/auth/me/me.controller.ts, txnet-backend/auth-service/src/app/auth/permissions/permission-registry.controller.ts, txnet-backend/auth-service/src/app/auth/register/register.controller.ts, txnet-backend/auth-service/src/app/common/validation/phone.schema.ts, txnet-backend/auth-service/src/app/locale/locale.service.ts, txnet-backend/billing-service/src/app/catalog/catalog-admin.schema.ts, txnet-backend/billing-service/src/app/payment/deposit/deposit-start.service.ts, txnet-backend/bot-service/src/app/locale/locale.service.ts, txnet-backend/bot-service/src/app/webhook/bot-webhook.registrar.ts, txnet-backend/shared-core/src/lib/i18n/translator/translator.ts, txnet-backend/support-service/src/app/conversations/conversations.controller.ts, txnet-backend/tenant-service/src/app/guide/guide-admin.controller.ts, txnet-backend/tenant-service/src/app/guide/guide-feedback.controller.ts, txnet-backend/tenant-service/src/app/guide/guide-internal.controller.ts, txnet-backend/tenant-service/src/app/guide/guide-public.controller.ts, txnet-backend/tenant-service/src/app/guide/guide-reader.ts
message: take the language from the locale meta or DEFAULT_LANGUAGE, and a formatting locale from a named constant (C-17)
```

## C-18 — a domain question is one named function

**Rule.** A question the product asks in more than one place — *is this the
platform's own tenant*, *is this caller the owner*, *may this user buy a
reseller* — is one exported function in the module that owns the type, and
every caller imports it. A literal compared at the call site is the question
asked again, and each copy drifts on its own.

**Why.** On 2026-10-13 the panel asked "is this the platform" 21 times inline
and six files each kept a local helper; two of them, both named
`isPlatformOwner`, meant different things (one also required `isOwner`). The
check holds the one literal that has already drifted; the rule holds the rest
in review. Owners: `site-pwa/src/app/(panel)/_lib/panel-menu.ts` (the
`TenantType` union) and `shared-core/src/lib/tenant/platform-tenant.ts`.
The other files in `except` are debt (FE-1-b, CS-1-c).

```check C-18
forbid: ['"`]platform_owner['"`]
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx, txnet-backend/**/*.ts
except: site-pwa/src/generated/**, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**, txnet-backend/.devin/**, txnet-backend/**/generated/**, **/*.spec.ts, **/*.test.ts, **/*.test.tsx, txnet-backend/*-e2e/**, txnet-backend/prisma/**, txnet-backend/**/seed*.ts, site-pwa/src/app/(panel)/_hooks/usePaletteData.ts, site-pwa/src/app/(panel)/_hooks/useVisibleMenu.ts, site-pwa/src/app/(panel)/_lib/panel-menu.ts, site-pwa/src/app/(panel)/_lib/reseller-menu.ts, site-pwa/src/app/(panel)/ai/_components/AiView.tsx, site-pwa/src/app/(panel)/ai/_components/UsageForecastView.tsx, site-pwa/src/app/(panel)/catalog/_lib/catalog-form.ts, site-pwa/src/app/(panel)/coupons/_components/GiftCodes.tsx, site-pwa/src/app/(panel)/coupons/_lib/coupon-form.ts, site-pwa/src/app/(panel)/gateways/_lib/gateway-form.ts, site-pwa/src/app/(panel)/groups/_lib/user-groups.ts, site-pwa/src/app/(panel)/my-resellers/_lib/support-access.ts, site-pwa/src/app/(panel)/my-resellers/_lib/users.ts, site-pwa/src/app/(panel)/resellers/_lib/purchase.ts, site-pwa/src/app/(panel)/resellers/_lib/resellers.ts, site-pwa/src/app/(panel)/services/_hooks/useOwnedReseller.ts, site-pwa/src/app/(panel)/settings/_lib/settings.ts, site-pwa/src/app/(panel)/settings/page.tsx, site-pwa/src/lib/auth-api.ts, txnet-backend/ai-service/src/app/profile/profile-builder.service.ts, txnet-backend/auth-service/src/app/auth/register/register.service.ts, txnet-backend/auth-service/src/app/tenant/tenant.ts, txnet-backend/billing-service/src/app/payment/deposit/deposit-quote.service.ts, txnet-backend/billing-service/src/app/payment/gateway/gateway-merchant.ts, txnet-backend/shared-core/src/lib/billing/operating-currency.ts, txnet-backend/shared-core/src/lib/redis/rate-limit-buckets.ts, txnet-backend/shared-core/src/lib/tenant/door.ts, txnet-backend/shared-core/src/lib/tenant/entitlements.ts, txnet-backend/shared-core/src/lib/tenant/host-surface.ts, txnet-backend/shared-core/src/lib/tenant/host.ts, txnet-backend/shared-core/src/lib/tenant/platform-tenant.ts, txnet-backend/tenant-service/src/app/currency/operating-currency.service.ts
message: import the question from the module that owns the tenant type (C-18) — isPlatformTenant(), not a literal compared here
```

## C-19 — text a person reads is never in code

**Rule.** A label, a message, a separator a reader sees (`"، "`, `"روشن"`) is a
locale key — C-06 in the panel, C-07 in the backend. Arabic-script literals
are allowed only in a module whose job is the script: digit and letter
normalisation, transliteration, language-specific matching. Those modules are
the first block of `except`; the rest are debt and leave with FE-1-a, FE-1-b,
FE-1-c and CS-1-d.

**Why.** The theme picker said `"اقیانوسی"` to English readers, and lists
were joined with a Persian comma in every language. A literal renders the same
in every locale, and no key-based check can see it.

```check C-19
forbid: ^(?!\s*(?://|\*|/\*|\{/\*)).*['"`][^'"`]*[\u0600-\u06FF]
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx, txnet-backend/**/*.ts
except: site-pwa/src/generated/**, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**, txnet-backend/.devin/**, txnet-backend/**/generated/**, **/*.spec.ts, **/*.test.ts, **/*.test.tsx, txnet-backend/*-e2e/**, txnet-backend/prisma/**, site-pwa/src/util/helper.ts, site-pwa/src/app/(panel)/_lib/palette.ts, site-pwa/src/app/(panel)/services/_lib/service-configs.ts, site-pwa/src/app/(panel)/catalog/_lib/catalog-form.ts, txnet-backend/billing-service/src/app/wallet/persian-search.ts, txnet-backend/tenant-service/src/app/guide/guide-search.ts, txnet-backend/tenant-service/src/app/purchase/slug-suggestion.ts, txnet-backend/billing-service/src/app/traffic/config-text.ts, txnet-backend/shared-core/src/lib/ai/suggestion-copy.ts, txnet-backend/bot-service/src/app/locale/bot-copy.fallbacks.ts, coinsite/src/app/layout.tsx, coinsite/src/util/theme.ts, site-pwa/src/app/(auth)/auth/_components/PasswordField.tsx, site-pwa/src/app/(auth)/auth/_components/ThemeDropdown.tsx, site-pwa/src/app/(panel)/catalog/_components/CatalogView.tsx, site-pwa/src/app/(panel)/catalog/_components/ProductWizard.tsx, site-pwa/src/app/(panel)/groups/_components/GroupWizard.tsx, site-pwa/src/app/(panel)/guides/_components/GuidesView.tsx, site-pwa/src/app/(panel)/my-resellers/[id]/users/[userId]/_components/GrantActions.tsx, site-pwa/src/app/(panel)/resellers/packages/_components/PackagesView.tsx, site-pwa/src/app/(panel)/support/_components/SupportSettingsView.tsx, site-pwa/src/context/LocaleContext.tsx, txnet-backend/auth-service/src/app/impersonation/impersonation.module.ts
message: move the text to locales/ and reference its generated key (C-19); script tables belong in the app's one script module
```

## C-20 — a file is small enough to read in one sitting

**Rule.** A source file (TypeScript, TSX, Go) is at most **400 lines**; a React
file declares at most **10** `useState`. Past that, split by job: sub-views
into `_components/`, state into a `_hooks/use<Thing>.ts` (or one `useReducer`),
pure logic into `_lib/` where it can be tested without rendering; in the
backend, a service's helpers into their own files beside it.

**Why.** On 2026-10-13, 113 files were over 400 lines (`billing-api.ts` 2501)
and `CatalogView` held 27 pieces of state. A file that long cannot be reviewed,
so nobody on a team can safely change it. `tools/codeshape.py` checks it: the
files over the line today are its baseline, each may shrink and none may grow,
and `--tighten` locks in a split.

## C-21 — what is replaced is deleted

**Rule.** The change that makes code unnecessary deletes it, with its spec and
every doc line naming it. `tools/codeshape.py` fails on a file nothing but
specs imports (`dead`), an exported name nothing outside specs uses
(`exports`), and a `dependencies` entry nothing imports (`deps`); a
file that exists for specs says so in its first lines
(`// codeshape: spec-only — <why>`), and a dependency used without an import is
in its `ALLOW_DEPS` with the reason. App code logs through the app's logger
(`console.info`/`warn`/`error` in Next server code), never `console.log`. A
`TODO` names the row that will do it.

**Why.** On 2026-10-13: five unused helper exports (one still logging
`"geelow"`), five files nothing imported, a guard kept in two copies, and 20
npm packages — `mongoose`, `ioredis`, `axios`, `install` — in apps that never
used them, each one a build and audit cost. Dead code also reads as live: the
next person copies the pattern from it.

```check C-21
forbid: console\.(log|debug)\(|\b(TODO|FIXME|HACK)\b(?!\([A-Z]+-[\w-]+\))
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx, txnet-backend/*/src/**/*.ts
except: site-pwa/src/generated/**, txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**, txnet-backend/.devin/**, txnet-backend/**/generated/**, **/*.spec.ts, **/*.test.ts, **/*.test.tsx, txnet-backend/*-e2e/**, site-pwa/src/services/user-locale-mock.ts
message: delete the debug line, log through the logger, and give a TODO its backlog id: TODO(FE-1-e) (C-21)
```

## C-22 — a comment says why; a file does one job

**Rule.**
- A comment explains *why*: the rule, the incident, the id (`F-093-h`,
  `ADR-0121`, `C-14`). It never narrates the next line.
- Every export of a `lib/`, `_lib/` or service module has a one-line `/** */`
  saying what it is for — that line is what the next person reads in their
  editor's hover.
- No commented-out code; git has it.
- Panel: `page.tsx` reads params and renders one view; the view is in
  `_components/`, its data and state in `_hooks/`, its pure logic in `_lib/`.
  Backend: a controller validates and calls a service; the service's pure parts
  are functions with their own spec.
- A number that means something is a named constant at the top of its module
  (`COPY_FEEDBACK_MS`, `MAX_RETRIES`); a value used in two files lives in one
  module and both import it (C-09 for closed sets).

**Why.** These are what let a second person — or a team — continue from where
the last one stopped without asking them. None is checkable by a regex, so
they rest on review; when one keeps being broken, it gets a check (see "The
format").

## C-23 — a name says what the thing is

**Rule.**
- Product words, the ones the docs use: `grant`, `tenant`, `reseller`,
  `panel`, `inbound`, `wallet`. Never `data`, `info`, `obj`, `temp`, `item2`,
  `handleStuff`, `doIt`, `manager`.
- The unit is in the name when there is one: `timeoutMs`, `ttlSec`,
  `sizeBytes`, `amountMinor`, `priceRial`. A bare `timeout` is a bug waiting
  for the next reader to guess seconds.
- A boolean is a question: `isOwner`, `hasGrant`, `canBuy`, `shouldRetry`.
- A function is a verb for what it does (`loadGrants`, `formatMoney`); a
  predicate is the question (`isPlatformTenant`); a React hook starts `use`.
- Casing (TypeScript): `camelCase` values and functions, `PascalCase` types,
  classes and components, `UPPER_SNAKE` module-level constants. Files:
  `kebab-case.ts`, `PascalCase.tsx` for a component, `useThing.ts` for a hook,
  `thing.spec.ts` / `thing.test.tsx` beside it. Go: Effective Go.
- One spelling per idea across the repo: the backend's `grant` is the panel's
  `grant`, not `subscription` in one file and `plan` in the next.

**Why.** A reader spends more time on names than on anything else. A name with
no unit or no domain word is read once by its author and guessed at by
everyone after.

```check C-23
forbid: ^\s*var\s+\w
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx
except: site-pwa/src/lib/motion.ts, site-pwa/src/lib/theme-script.ts
message: use const (or let when it is reassigned) — var is function-scoped and hoisted (C-23); the two inline <head> scripts are ES5 on purpose
```

## C-24 — types are honest

**Rule.**
- No `any`. A value of unknown shape is `unknown` and is narrowed.
- No `as unknown as T`: it tells the compiler to stop checking. Parse it
  (zod), convert it (`Number(x)`, `new Decimal(x)`), or fix the type upstream.
- No non-null `x!.y`: handle the missing case, or make the type say it cannot
  be missing.
- No `@ts-ignore` / `@ts-nocheck`. A known compiler gap is
  `@ts-expect-error -- <why>`, which fails once the gap closes.
- Data from outside the process — a request body, a queue message, a webhook,
  `JSON.parse`, `localStorage`, a third-party API — is parsed with a zod
  schema at the edge. Inside, the types are trusted and not re-checked.
- A `switch` over a union or enum is exhaustive: the `default` calls
  `assertNever(x)`, so a new member is a compile error, not a silent fall-through.

**Why.** Every one of these turns a compile error into a runtime one — the
kind that shows up on a real screen with every suite green. On 2026-10-13
`PaymentSummary` formatted a rial string through `as unknown as number`.
`@ts-ignore` is a `check`; `any`, the double cast and `!` are counted per file
by `codeshape.py` `smells` (98 double casts in 49 files today) and may only go
down.
In `txnet-backend` the rule is held by type-aware ESLint instead (CS-1-j):
`any`, `!`, a non-exhaustive `switch` and `@ts-ignore` fail `npm run lint`,
whose per-file baseline (`<project>/eslint-suppressions.json`) only shrinks.
The double cast stays with `codeshape.py`; no lint rule names it.

```check C-24
forbid: @ts-(ignore|nocheck)\b
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx
message: fix the type; a real compiler gap is `// @ts-expect-error -- <why>` (C-24)
```

## C-25 — an error is handled once, on purpose

**Rule.**
- No empty `catch`. A caught error is converted (to a domain exception with a
  locale key), rethrown with context, or logged with the ids it concerns — and
  only one of those, in one place: the layer that can do something about it.
- `catch (e)` types `e` as `unknown`; read it with `e instanceof Error`.
- A promise is awaited. One deliberately left running is `void doThing()` with
  a comment saying why nothing waits for it.
- Backend: what a user will read is a domain exception carrying a backend
  locale key (C-07); an `Error` is for a broken invariant only.
  Panel: a failed call shows the API's localised message (`useApiError`), never
  `e.message` raw.
- Go: return `fmt.Errorf("doing x: %w", err)`; do not log and also return.

**Why.** A swallowed error is the bug that is reported three weeks later as
"sometimes it doesn't save". The two empty catches that remain are inside the
ES5 `<head>` scripts, where a throw would blank the page. In `txnet-backend`,
an empty block and an un-awaited promise fail `npm run lint` (`no-empty`,
`no-floating-promises`, CS-1-j) — a type-aware rule sees the promise a regex
cannot.

```check C-25
forbid: catch\s*(\([^)]*\))?\s*\{\s*\}
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx
except: site-pwa/src/lib/motion.ts, site-pwa/src/lib/theme-script.ts
message: handle the error — convert, rethrow with context, or log with the ids — never drop it (C-25)
```

## C-26 — config comes from the validated env module

**Rule.** `process.env` is read in one module per app: each service's
`config/env.validation.ts` (zod, fails at boot), `site-pwa/src/env.ts`,
`coinsite/src/env.ts`, and build config files. Everything else imports the
typed, defaulted value from there.

**Why.** A variable read raw is a string or `undefined` at whatever moment it
is read; a typo in its name is `undefined` for ever and nothing fails. Read
once through the schema, a missing or malformed value stops the boot with its
name. `codeshape.py` counts raw reads per file (`raw-env`).

## C-27 — one home per need

**Rule.** Before writing a helper, use the home. The second time the same logic
is needed it is moved to its home and both callers import it — not pasted.

| need | panel (`site-pwa`) | backend (`txnet-backend`) |
|---|---|---|
| call the API | `lib/api-request.ts` and the `lib/*-api.ts` clients | — |
| a route | `lib/routes.ts` (C-10) | — |
| a header / cookie / permission name | `@/generated/wire` (C-04) | `shared-core/src/lib/http` (C-04) |
| a translated string | `@/generated/i18n-keys` (C-06) | `BackendI18nKeys` / `BotKeys` (C-07) |
| money | `_lib/money.ts` | `Decimal`, `shared-core/src/lib/billing` (C-02) |
| a date or time | `_lib/datetime.ts`, `lib/time-zone.ts` | `shared-core/src/lib/time` |
| digits and numbers | `_lib/digits.ts` (`numberLocale`) | — |
| a control, a dialog, a table | `(panel)/_components/kit` (C-13) | — |
| live updates | `hooks/useLiveReread.ts` (C-14) | the outbox, `shared-core/src/lib/automation` (C-08) |
| browser storage | `lib/storage.ts` (FE-1-l) | — |
| copy to clipboard | `_lib/clipboard.ts` | — |
| a Redis key, a rate-limit bucket | — | `RedisKeys` (C-03), the bucket registry (C-05) |
| tenant scope | — | `tenantTransaction` / `withTenant` / `runWithTenant` |
| who holds a key | — | `findKeyHolders` (C-15) |
| a feature or a limit | — | `TenantEntitlements`, `resellerLimitOf` (C-16) |

A need that has no home gets one in the change that needs it twice, and a row
in this table.

**Why.** On 2026-10-13: five copies of the digit normaliser, six of
"is this the platform", two identical guards, two network drivers sharing 300
pasted blocks. A fix made to one copy is a bug left in the others.
`codeshape.py` fails on a new block of 8 meaningful lines pasted across files
(`dupes`) and on a home bypassed (`raw-fetch`, `raw-storage`); the copies there
today are its baseline.

## C-28 — data access is bounded

**Rule.**
- No query inside a loop. Load the set once (`where: { id: { in: ids } }`),
  then join in memory; a `Promise.all` over a list a user controls is chunked.
- Every list endpoint is paged, with a maximum page size the server enforces;
  the panel never asks for "all".
- `select` the columns the caller uses; a wide JSON column is not read to show
  a name.
- A new `where` or `orderBy` on a table that grows with users or time ships its
  index in the same migration.
- Work that is slow, retried or fans out (sending, provisioning, metering,
  recomputing) goes to `worker-service` through the queue; a request does not
  wait for it.
- Every call out of the process (a panel API, a payment gateway, an SMS line)
  has a timeout and a capped, backed-off retry; an unreachable provider fails
  one request, not the worker.
- Every Redis key has a TTL unless the keyspace contract says it is permanent.

**Why.** None of these is slow on a developer's ten rows. They are what makes
the platform fall over at a hundred resellers with thousands of users each, and
they are expensive to retrofit because callers come to rely on the shape.

## C-29 — a write is safe to repeat and to race

**Rule.**
- A consumer, a webhook handler, a payment callback and a retried job are
  idempotent: a dedupe key or a unique constraint makes the second delivery a
  no-op.
- A change that spans rows is one transaction; an event about it leaves through
  the outbox in that transaction, never after it.
- Read-modify-write is a conditional update (`updateMany({ where: { id,
  version } })`, an atomic increment, a Lua script in Redis), never read, then
  compute, then write.
- Tenant data is read and written inside `tenantTransaction` / `withTenant`; a
  bare client on an RLS table sees nothing and is refused
  (`docs/platform/tenant-context/contract.md`). A spec with a fake client
  cannot see this; a new tenant query is run once against the dev database.
- Money moves only by appending a ledger row (C-02).
- A transaction is short and touches only the database: no HTTP call, gateway
  call, broker publish or sleep while it is open. The call goes before it, or
  after it through the outbox. A transaction held open on a slow provider
  holds its row locks and a pool connection for as long as the provider takes.
- Rows are locked in one order everywhere (by id, parent before child), so two
  transactions never wait on each other. `SELECT … FOR UPDATE` is for the case
  a conditional update cannot express, and names it in a comment.

**Why.** Queues redeliver, users double-click, gateways call back twice. Each
of these bugs passes every spec that sends one request. The lock rules are the
same bugs under load: a deadlock or an exhausted pool appears at a hundred
resellers, never on a developer's machine.

## C-30 — React renders from minimal state

**Rule.**
- State holds what cannot be computed; everything else is derived during render.
  `useMemo` only where a measurement showed the cost.
- An effect synchronises with something outside React (a socket, a timer, the
  DOM) and returns its cleanup. Fetching a page's data is `useLiveReread` or the
  area's data hook; copying props into state is a bug.
- A list key is the row's id. An index key is allowed only for a list that never
  reorders, inserts or deletes (a skeleton).
- `eslint-disable` is a last resort and says why: `// eslint-disable-next-line
  react-hooks/exhaustive-deps -- runs once per tenant switch`.
- Server components by default; `"use client"` at the smallest component that
  needs it. A heavy client-only library (charts, an editor, a date picker) is
  `next/dynamic`.
- Lists longer than a page are paged (`kit/Pagination`).

**Why.** Mirrored state and index keys are where a panel shows one row's data
in another row. On 2026-10-13: 41 index keys, 31 unexplained exhaustive-deps
switches. `codeshape.py` counts both per file (`index-key`, `lint-off`).

## C-31 — styling is tokens and logical sides

**Rule.** Colours, radii and type sizes come from the theme tokens
(`globals.css`, `contract.ux.md`); no hex or `rgb()` in a component. Sides are
logical — `ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`/`text-start` — never
`ml-`/`mr-`/`left-`/`text-left`, so the same markup is right in Persian and
English. Gold is never on a control (`contract.ux.md`).

**Why.** Every hard-coded colour is a dark-theme bug and every physical side a
mirror bug in the other direction. `codeshape.py` counts `hex-color` and
`physical-side` per file.

## C-32 — safe at every boundary

**Rule.**
- Every route authorises on the server: a guard or a permission key. A button
  the UI hides is not a permission.
- Every input from outside is validated at the edge (C-24) and size-limited.
- SQL goes through Prisma or the tagged `$queryRaw`; never the `Unsafe`
  variants, never a string built from input.
- No `dangerouslySetInnerHTML` (the two theme `<head>` scripts are constants),
  no `eval` / `new Function`.
- No key material, token or password in code or in a fixture that is not
  obviously fake; secrets come from the vault or env (C-26).
- Anything that must be unguessable — a token, a code, an id in a URL — comes
  from `crypto` (`randomUUID`, `randomBytes`, `randomInt`), never
  `Math.random`.
- Logs never carry a secret or personal data (C-38).

**Why.** A reseller platform holds other people's money and customers. These
are the mistakes that cannot be fixed after the fact.

```check C-32
forbid: \$(query|execute)RawUnsafe|dangerouslySetInnerHTML|(?<![.\w])eval\((?![^)]*:\s*\w)|new Function\(|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk_live_[0-9a-zA-Z]{8,}|\bAKIA[0-9A-Z]{16}\b
in: site-pwa/src/**/*.ts, site-pwa/src/**/*.tsx, coinsite/src/**/*.ts, coinsite/src/**/*.tsx, txnet-backend/*/src/**/*.ts
except: site-pwa/src/app/layout.tsx, site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx, txnet-backend/**/*.spec.ts, txnet-backend/*-e2e/**
message: no raw unsafe SQL, injected HTML, eval or key material in code (C-32)
```

```check C-32
forbid: Math\.random\(
in: txnet-backend/*/src/**/*.ts
except: txnet-backend/**/*.spec.ts, txnet-backend/*-e2e/**, txnet-backend/shared-core/src/lib/automation/confirm-publish.ts
message: use crypto.randomUUID / randomBytes / randomInt for anything that must not be guessed (C-32); a correlation suffix that may be guessed is excepted by name
```

## C-33 — a spec guards behaviour

**Rule.**
- A bug fix starts with a spec that fails on the bug, for the reason in the
  report (CODE-LAYOUT.md "Order of work").
- A spec drives the public surface — the route, the hook, the exported
  function — and asserts what a user or caller sees, not private calls.
- Its name is a sentence of behaviour: `"refuses a second start of the same
  payment"`.
- Time is a fake clock (`vi.useFakeTimers`, an injected `now`), never a sleep.
- `.only`, `.skip`, `fit`, `xit` never reach a commit; a spec that cannot run
  yet is a backlog row.

**Why.** A skipped spec is a deleted spec nobody decided to delete; a sleep is a
spec that fails on a busy server — this one also hosts the live site.

```check C-33
forbid: \b(it|describe|test)\.(only|skip)\(|(?<![\w.])(fit|fdescribe|xit|xdescribe)\(
in: site-pwa/src/**/*.test.ts, site-pwa/src/**/*.test.tsx, txnet-backend/**/*.spec.ts, txnet-backend/*-e2e/**/*.ts
except: txnet-backend/.agents/**, txnet-backend/.claude/**, txnet-backend/.cursor/**, txnet-backend/.devin/**
message: run the whole spec — make it pass, or delete it and open a row (C-33)
```

## C-34 — one library per job

**Rule.** The panel has one of each: HTTP `fetch` through `api-request.ts`,
validation `zod`, state `zustand`, animation `framer-motion`, toasts
`react-hot-toast` (via `kit/notify`), icons `lucide-react`, dates `Intl` plus
`react-multi-date-picker`. The backend: Nest, Prisma, `zod`, `ioredis`,
RabbitMQ through `shared-core`. A new dependency is a question to the user
naming what it replaces, its size and its maintenance. One that nothing imports
fails `codeshape.py` `deps`; one needed without an import is in `ALLOW_DEPS`
with its reason.

- Versions are locked: the lockfile (`package-lock.json`, `go.sum`) is
  committed and changes only in a change that meant to change a dependency.
- A dependency with a published critical or high advisory that reaches our
  code (a framework, an HTTP, auth or parsing library) is upgraded as its own
  backlog row, ahead of feature work. `npm audit --omit=dev` and
  `govulncheck ./...` are read when a dependency changes.
- One major version per library across the repo: `coinsite` and `site-pwa`
  run the same Next major, so one advisory has one fix.

**Why.** Two libraries for one job means two behaviours, two upgrade paths and
two places a security advisory lands. On 2026-10-13 the panel carried 16
packages it never imported. The 2026-09 host compromise came in through a
known Next.js advisory on a version `coinsite` had not upgraded (FE-1-k):
an advisory is an incident that has not happened yet.

## C-35 — a function does one thing

**Rule.**
- About 50 lines at most; past that, it is doing two things — name them and
  split.
- At most 3 positional parameters; more is one options object with named
  fields.
- No boolean flag parameter (`render(true)`): two functions, or an option
  with a name.
- Nesting at most 3 levels: return early on the cases that end.
- No nested ternary: an `if`, a lookup `Record`, or a small function.
- Pure where it can be: compute in a function, do I/O at the edge, so the
  logic is testable without mocks.

**Why.** Short, flat functions are the ones a reviewer actually checks. The
alternative was measured on 2026-10-13: 111 lines of nested ternaries.

## C-36 — Go

**Rule.** `gofmt` and `go vet` clean. `context.Context` is the first parameter
of anything that does I/O, and is honoured. Errors are wrapped
(`fmt.Errorf("register inbound: %w", err)`) and returned to the layer that
decides; a handler logs once. `panic` only for a broken invariant, with a
message naming it. `_ = f()` only on a response write after the status is sent,
with a comment. Shared names come from their declaration (C-04, C-03).

- Every goroutine has an owner that can stop it: it takes a `ctx`, returns
  when `ctx.Done()` closes, and the owner waits for it (`errgroup`,
  `sync.WaitGroup`) on shutdown. No `go f()` whose end nobody waits for.
- Work fanned out over a list a caller controls is bounded (a worker pool or
  `errgroup.SetLimit`), never one goroutine per item.
- State shared between goroutines is behind one `sync.Mutex` declared beside
  the fields it guards, or owned by one goroutine and reached by channel.
  `go test -race` runs on a package that starts goroutines.
- Every outbound `http.Client` has a `Timeout`; `http.DefaultClient` is not
  used (C-28).

**Why.** The Go services sit on the hot path (ForwardAuth, metering); an error
dropped there is an outage nobody can trace. A goroutine nobody stops is a
leak that grows with traffic, and a data race passes every test that does not
run with `-race`.

## C-37 — an API change does not break its consumers

**Rule.**
- Add, never rename or retype in place. A field is removed only after every
  consumer stopped reading it — the panel, the bot, the other services.
- The unit's `contract.md` changes in the same commit as the code (§8).
- Time on the wire and in the database is ISO-8601 UTC; it is zoned only for
  display, through `_lib/datetime.ts` / `shared-core/src/lib/time`.
- Money on the wire is a decimal string with its currency code (C-02).
- An error response carries a locale key, never prose.
- A queue message and an outbox event are an API too: a consumer ignores
  fields it does not know, a producer only adds fields, and a payload whose
  meaning changes gets a new event type rather than a changed one (C-08). A
  message already in a queue during a deploy is read by the new consumer.
- A database column follows the same rule, in steps (C-39).

**Why.** The panel, the bot and the services deploy separately; a breaking
change lands as a blank page in whichever deploys second — and a message
queued before the deploy is consumed after it.

## C-38 — a log line can be acted on

**Rule.** Through the app's logger — Nest `Logger` named after the class,
`console.info`/`warn`/`error` in Next server code. The line says what happened
and the ids it happened to (`tenant`, `payment`, `grant`), not "error". Levels:
`error` someone must act, `warn` degraded but handled, `info` a state change
worth knowing, `debug` off in production. Never a token, password, OTP, card
number or full phone number; mask what identifies a person.

**Why.** On a multi-tenant platform a log is read during an incident, by
someone who did not write the code, about a tenant they do not know.

## C-39 — a schema change ships in steps

**Rule.**
- A change that would break code still running — dropping or renaming a
  column or table, changing a type, making an existing column `NOT NULL` — is
  done as expand, migrate, contract:
  1. **expand** — add the new shape beside the old; code writes both (or the
     new one and a backfill fills it);
  2. **migrate** — every reader and writer moves to the new shape, in its own
     change, across every service that reads the table;
  3. **contract** — a later migration removes the old shape. Each destructive
     line ends `-- contract: <row id>`, naming the row that finished step 2.
- `NOT NULL` on a column with rows: add it nullable, backfill, then set it.
- A migration that has been committed is never edited — on any machine it may
  already be applied, and `prisma migrate` then refuses or diverges. A mistake
  is fixed by the next migration.
- A table that carries `tenantId` gets RLS enabled, forced and its policy in
  the migration that creates it (`docs/platform/tenant-context/contract.md`;
  `rls-coverage.spec.ts` fails without it).
- An index on a table that already holds production data is built so that it
  does not block writes for the length of the build, in a migration of its
  own; one that grows with users or time ships with the filter it serves
  (C-28).
- The migration's name says what changed in product words
  (`a_grant_remembers_its_days`), like a commit subject.

**Why.** Services deploy one by one, and during a rolling deploy the old and
new code run against the same database at once. A column dropped in the same
release that stops reading it is a 500 on every instance that has not
restarted yet — and in production there is no `migrate reset`. 69 of the first
315 migrations dropped or renamed in place, which was safe only because there
was no production data and no rolling deploy yet. Those are excepted by date;
from 2026-10-14 the marker is what makes the step a decision.

```check C-39
forbid: ^(?!.*--\s*contract:\s*[A-Z]+-[\w-]+).*\b(DROP\s+(COLUMN|TABLE)|RENAME\s+(COLUMN|TO)|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE)\b
in: txnet-backend/prisma/domains/migrations/**/*.sql
except: txnet-backend/prisma/domains/migrations/202609*/**, txnet-backend/prisma/domains/migrations/2026100*/**, txnet-backend/prisma/domains/migrations/20261010*/**, txnet-backend/prisma/domains/migrations/20261011*/**, txnet-backend/prisma/domains/migrations/20261012*/**, txnet-backend/prisma/domains/migrations/20261013*/**
message: expand first, move the readers, then drop — end the destructive line with `-- contract: <row id>` naming the row that moved them (C-39)
```

## C-40 — a screen works for every reader

**Rule.**
- A control is a kit primitive (C-13) or a native `<button>` / `<a>`. A
  clickable `<div>`, `<span>` or `<li>` cannot be reached by keyboard and is
  not announced; a backdrop that closes on click is the kit `Dialog` / `Sheet`.
- An icon-only control has an `aria-label` (the kit `IconButton` requires it),
  from a locale key (C-19).
- An `<img>` / `<Image>` has `alt`: what it shows, or `alt=""` when it is
  decoration.
- A state is never told by colour alone: a status has its word or icon too
  (`StatusPill`), so it reads in every theme and to a colour-blind reader.
- Motion honours `prefers-reduced-motion` (`contract.ux.md` M3); focus is
  visible (K2) and returns to the trigger when an overlay closes (K7).
- Text meets the contrast `contract.ux.md` sets, in all three themes and under
  a tenant's brand colour.

**Why.** A reseller's customers are whoever buys from them — on a phone, with
a screen reader, with a keyboard, in a bright street. The kit already does the
hard part; these are the ways a screen built beside it undoes it. Two
hand-rolled backdrops are the `except` today and leave with FE-1-m.

```check C-40
forbid: ^(?!\s*(//|\*|/\*|\{/\*)).*(<(img|Image)\b(?![^>]*\balt=)[^>]*>|<(div|span|li|td|tr|p)\b[^>]*\bonClick=)
in: site-pwa/src/**/*.tsx, coinsite/src/**/*.tsx
except: site-pwa/src/**/*.test.tsx, site-pwa/src/app/(panel)/services/_components/QrDialog.tsx, site-pwa/src/app/(panel)/_components/guide/GuideList.tsx
message: use a kit primitive or a native button/a, and give an image its alt (C-40, contract.ux.md K3–K7)
```
