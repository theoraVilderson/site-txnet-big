---
id: code-layout
status: active
updated: 2026-09-09
unit_aliases:
  - identity:auth
  - identity:impersonation
  - audit:account-switch
  - tenant:tenant
  - auth-api:auth-service
  - bot-app:bot-service
  - auth-api:auth-service-e2e
  - panel-web:site-pwa
  - marketing-web:coinsite
  - forward-auth:auth-handler
  - i18n:i18n-platform
  - i18n:locales
  - redis-keyspace:redis
  - redis-keyspace:session
  - redis-keyspace:otp
  - redis-keyspace:cache
  - redis-keyspace:config
---

# Code layout — the mirror rule

The docs tree already has stable ids. This file makes the **code tree carry the
same ids**, so a path is derived, never remembered.

> **The mirror rule: a unit id is a folder name. One unit, one folder, one owner.**

```
docs/domains/identity/        <->   txnet-backend/auth-service/src/app/auth/
docs/platform/i18n/           <->   i18n-platform/services/locale-service/
docs/platform/forward-auth/   <->   auth-handler/internal/
docs/interfaces/panel-web/    <->   site-pwa/src/app/
```

Given `unit: identity`, the code is wherever that unit's `source:` globs point —
`tools/docs-check.py` fails if they do not resolve, so the mirror cannot
silently break. Most Prisma domains here are `status: draft` with `source: []`:
no code exists yet, so there is nothing to mirror until a service is built.

## The roots — this is a polyglot monorepo, not one `apps/` tree

| root                                                                          | holds                                                                                                                                     | mirrors                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `txnet-backend/auth-service/src/app/<concern>/`                               | NestJS modules for units already live (`identity`)                                                                                        | `docs/domains/identity/`, `docs/interfaces/auth-api/`     |
| `txnet-backend/auth-service/src/app/account-switch/`                          | the account-switch group — `audit`'s first service, hosted in this process because its only collaborators are identity's proof operations | `docs/domains/audit/`                                     |
| `txnet-backend/auth-service/src/app/tenant/`                                  | `tenant`'s host -> tenant resolution — its first service, hosted here because the only caller so far is this app's edge (ADR-0020)   | `docs/domains/tenant/`                                    |
| `txnet-backend/shared-core/src/lib/<unit>/`                                   | Nx library `@txnet-backend/shared-core`: a rule two Nx **apps** must both hold, and an app cannot import an app. `automation/schedule.ts` is the first — the writer and the runner of a schedule cannot be allowed to disagree about what one means | the unit named by the folder (`docs/domains/automation/`) |
| `txnet-backend/messenger/src/`                                                | Nx library `@txnet-backend/messenger`: bot driver, capability set, `BotView` renderer, deep links                                         | `docs/platform/messenger/`                                |
| `txnet-backend/bot-service/src/app/`                                          | the Telegram/Bale surface: webhook, conversation state, flows                                                                             | `docs/interfaces/bot-app/`                                |
| `txnet-backend/worker-service/src/app/`                                       | background work: the tick publisher, the tick consumer, the job registry. Serves no HTTP (ADR-0027)                                        | `docs/domains/automation/`                                |
| `txnet-backend/billing-service/src/app/`                                      | billing scaffold (not yet implementing `billing`)                                                                                         | `docs/domains/billing/` (stays `draft` until real)        |
| `txnet-backend/prisma/domains/*.prisma`                                       | one schema file per business domain                                                                                                       | `owns_tables:` in that domain's `INDEX.md`                |
| `auth-handler/internal/`                                                      | Go Traefik ForwardAuth gateway                                                                                                            | `docs/platform/forward-auth/`                             |
| `i18n-platform/services/locale-service/` + `i18n-platform/clients/{go,node}/` | gRPC translation source of truth + shared clients                                                                                         | `docs/platform/i18n/`                                     |
| `site-pwa/src/app/`                                                           | Next.js user panel (routes, route handlers, components)                                                                                   | `docs/interfaces/panel-web/`, `docs/SURFACES.md` rows     |
| `coinsite/src/app/`                                                           | Next.js public landing site                                                                                                               | `docs/interfaces/marketing-web/`, `docs/SURFACES.md` rows |

Registered in `docs/SURFACES.md` front matter as `code_roots:` so
`tools/where.py` can fall back to a filename scan when a surface row is missing.

## Known aliases (the mirror rule doesn't hold literally here)

This codebase predates the skeleton, so its folder names don't spell out the
unit id (`identity`'s code is under `auth/`, `auth-api` lives in
`auth-service/`, `i18n` in `i18n-platform/`). Renaming a live service folder
just to satisfy a doc tool is not worth the blast radius, so `tools/drift.py`
reads the `unit_aliases:` list above instead of assuming folder == id: each
`unit:alias` pair tells its ambiguous-ownership check that a path segment
named `alias` is understood to belong to `unit`, the same way the literal id
would. A `source:` glob is still flagged if it matches **no** alias for its
unit — the check still catches a genuinely over-broad or misassigned glob.

Add a pair here the day a new unit's `source:` first resolves to a folder name
that isn't its id. Do not add one just to silence a warning you haven't
verified — an alias asserts real ownership, the same as a `source:` path does.

## Inside the NestJS auth-service (the one live backend unit so far)

```
auth-service/src/app/auth/
  auth.controller.ts        transport only — mirrors interfaces/auth-api
  auth.service.ts           the rules; matches domains/identity/rules.md
  *.schema.ts                zod shapes; matches interfaces/auth-api/contract.md
  __tests__/ (or *.spec.ts)
```

`billing-service` is a scaffold with no business logic yet — it stays out of
`domains/billing`'s `source:` until it actually implements something.

### Three tiers of test, told apart by the filename

| file                                    | what runs                                      | needs   | how                |
| --------------------------------------- | ---------------------------------------------- | ------- | ------------------ |
| `*.spec.ts`                             | one class, collaborators mocked                | nothing | `npm test`         |
| `*.int.spec.ts`                         | one store against a real Redis, or the isolation harness against a real Postgres | Docker  | `npm run test:int` |
| `auth-service-e2e/src/**/*.e2e.spec.ts` | the whole app over HTTP, real Postgres + Redis | Docker  | `npm run test:e2e` |

All three run in CI (`.github/workflows/ci.yml`), one job each.

### Running them without burning the session

`ts-jest` runs with `isolatedModules`: it transpiles and does **not**
type-check, which is what makes the suite ~19s instead of ~44s. The type check
is not gone, it moved — `npx tsc -p auth-service/tsconfig.spec.json --noEmit`,
once, before an item is declared done (`AGENTS.md`).

**`-t "<name>"` does not narrow anything.** Jest boots and compiles all 33
suites and *then* filters, so `npm test -t Foo` costs a full run. Narrow by
**path**: `npx jest -c auth-service/jest.config.cts <path>` is ~8s for one
unit's folder. Run the paths you touched while iterating, and `npm test` once at
the end.

**Narrow the e2e run the same way — by path, to the files the change can
reach.** `npm run test:e2e` is ~230s: ~31s of Docker start-up, then six files
that cost strictly additively, because `maxWorkers: 1` (one Postgres, one
Redis, every spec wiping them between tests). One file is **~74s** — the
container start-up is a floor you always pay, and everything above it is the
files you chose.

```bash
npx jest -c auth-service-e2e/jest.config.cts contract.e2e      # ~74s
npx jest -c auth-service-e2e/jest.config.cts 'contract|gates'  # a regex, not a path
```

The positional argument is a regex matched against the full path, so a
filename fragment is enough. Which fragment:

| what the change touched | run |
|---|---|
| an envelope, a status code, the `api` prefix, CORS, the refresh cookie's attributes | `contract.e2e` |
| register / OTP / verify-phone / login / refresh / logout | `auth-flow.e2e` |
| the captcha gate or a rate limit | `gates.e2e` |
| forgot-password, reset, or session revocation | `password-reset.e2e` |
| the account-switch group | `account-switch.e2e` |
| the `/admin/workers` routes | `worker-admin.e2e` |
| anything read from config — a domain, an origin, a language | `deployment.e2e` |

**Run all six only when the change is global**, and it is global exactly when
it is in one of these: `auth-service-e2e/src/support/**` (the harness every
file boots), `app.module.ts`, `main.ts`, a global guard / filter / pipe /
middleware, or `prisma/seed.js`. Those reach every file by construction, and a
one-file run then proves nothing about the other five.

A backlog item that changed no `contract.md` row runs **no** e2e at all — the
rule below has not moved.

**Never start an e2e run the user did not ask for.** Writing an `*.e2e.spec.ts`
when a `contract.md` row changed is still required; *running* the tier is the
user's call, because at ~74s a file it is the one command in this repo that can
eat a session on its own. Say which file now covers the change and let them
decide. `npm test` and the path-narrowed unit runs need no such permission.

The e2e project boots `AppModule` in-process and drives it with supertest, so
it answers "does this route still return that shape?" — the questions
`interfaces/auth-api/contract.md` asks. A unit spec cannot answer them: the
prefix, the guards, the cookie and the error envelope are all assembled
outside the class under test. Start there when a change is about the wire,
not the rule.

### Order of work — the spec is written first

A new feature or capability starts with its test. Write the `*.spec.ts` that
states the invariant the item turns on, watch it fail for the reason you
expect, then write the implementation, then run it. An item whose first edit is
production code was written in the wrong order, and its test — authored after
the fact, against code already in front of you — asserts what the code does
rather than what it must do. That is the failure mode the ceiling below is
also aimed at.

Failing first is the part that carries the value: a spec that has never been
red has not been shown to test anything.

**Ceiling — a budget, not a target.** One backlog item earns at most **one** new
`*.spec.ts`, covering the invariant the item turns on: the thing that would
break silently, not the thing that is obviously correct.
The ceiling governs work you generate yourself while shipping an item. It does
not govern a coverage backfill the user asks for explicitly — that is its own
backlog row, sized by what is missing rather than by this budget. Without the
distinction the next session reads twelve new spec files as a violation of a
rule it is meant to follow.

- `*.int.spec.ts` and `*.e2e.spec.ts` are written only when a `contract.md` row
  changes. Drift between a contract and its wire is what they catch, and it is
  what they have caught here — the two entries in
  `interfaces/auth-api/open-questions.md` marked _found by e2e_.
- Never assert that a mock was called with the arguments you passed it in the
  same minute. That tests wiring written from the same understanding, and it
  passes whether or not the understanding was right.
- Never hand-edit an existing spec's assertions to match a new signature. Forty
  broken assertions means the fake is too detailed — simplify the fake, in one
  edit.
- Never write a spec for a rule that reading the code already settled.

The ceiling exists because an agent with no instruction writes tests without
bound, and a large suite of self-authored unit tests mostly re-asserts its
author's reading of the code — including the wrong parts. `00-PROTOCOL.md`
§6.2b, listing the call sites before a signature changes, is the cheaper half of
the same job and it is mandatory.

Existing `*.e2e.spec.ts` files stay. That tier earned its place.

### Outside the Nest workspace

Three other stacks carry tests, and none of them uses jest:

| where                                    | runner                       | how                                        |
| ---------------------------------------- | ---------------------------- | ------------------------------------------ |
| `auth-handler/`, `i18n-platform/**` (Go) | `go test`                    | `go test ./...` per `go.work` member       |
| `i18n-platform/clients/node`             | `node --test` (no framework) | `npm test` — exercises the shipped `dist/` |
| `site-pwa/`, `coinsite/`                 | vitest                       | `npm test`                                 |

The shared locale clients are two implementations of one contract (a blocking
boot, a per-language cache replace, the same fallback chain), so their tests are
deliberately twins: `clients/go/client_test.go` and
`clients/node/client.test.mjs` assert the same **contract**, not the same list
of tests. Where a case exists in only one of them it is because the two clients
differ in shape — Go boots inside `New` under a `context.Context`, Node's
`ready()` is lazy and memoised — and each file's header names its own one-sided
cases and why. Change one and change the other, or add a line to that list
saying why the twin cannot have it.

## Next.js apps (`site-pwa`, `coinsite`)

```
src/app/<route-group>/<route>/page.tsx     the route — a SURFACES.md row
src/app/api/<name>/route.ts                a route handler — proxy or serves i18n
src/components/, src/lib/, src/services/   shared client code, not a surface itself
```

The component/route filename is what the user is pointing at, so it must
contain the noun they say. `register/page.tsx` under `app/api/auth/register` is
already how `site-pwa` names things — keep doing that; it's what makes the
filename fallback in `tools/where.py` work at all.

## Symptom -> role — how to narrow _inside_ a unit

The tiers in `00-PROTOCOL.md` §3 narrow to a unit and stop. For a unit with
thirty files that is not narrow, and it is exactly where an agent starts reading
everything. This table is the last step of the funnel: what broke -> which file
role holds it. **Project-owned** — three stacks here, so three vocabularies.

| symptom                                                                               | look in                                                                                                                                                                                                      | do not start in                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 401 / 403 / redirected to login on a protected route                                  | `auth-handler/internal/` (ForwardAuth `/validate`), then the Traefik middleware labels                                                                                                                       | the NestJS service                   |
| session gone / logged out too early / revoke didn't take                              | the Redis key builder (`auth-service/src/app/redis/redis.keys.ts`) + `docs/platform/redis-keyspace/contract.md`                                                                                              | the login controller                 |
| cookie set but not sent back / lands logged out                                       | `site-pwa/src/app/api/auth/[...path]/route.ts` (the proxy rewrites cookies)                                                                                                                                  | `auth.service.ts`                    |
| 400 / validation / wrong error shape                                                  | `*.schema.ts` (zod), then `*.controller.ts`                                                                                                                                                                  | the repository or Prisma             |
| endpoint 404 / route not firing                                                       | `*.controller.ts` + its module registration in `auth.module.ts`; for the panel, the route-handler file path itself                                                                                           | anything else                        |
| right shape, wrong values                                                             | `*.service.ts`                                                                                                                                                                                               | the controller                       |
| wrong / missing translated text                                                       | `locales/**` content first, then the `i18n` client cache — `locale-service` serves a snapshot, so stale text is usually a cache, not a missing key                                                           | the component                        |
| data written wrong, or not written                                                    | the Prisma call site in the service + `prisma/domains/*.prisma`                                                                                                                                              | the controller                       |
| works once, then fails / state leaks across requests                                  | Redis TTLs and key versioning (`redis-keyspace`), then the OTP/rate-limit services                                                                                                                           | the controller                       |
| service refuses to boot                                                               | the `locale-service` gRPC dependency (`i18n`) — `auth-api` and `forward-auth` both fail closed without a first snapshot                                                                                      | the service's own code               |
| bot answers nothing at all                                                            | the webhook: `bot-service`'s `BotWebhookRegistrar` + `getWebhookInfo` (a bot token holds **one** URL, and only `bot-service` sets it)                                                                        | the flows                            |
| bot answers, but every auth step is refused                                           | the seam: `SERVICE_AUTH_TOKEN` must be the _same_ value in `bot-service` and `auth-service`, or the captcha guard rejects every call                                                                         | the conversation state               |
| the bot signs a chat out mid-conversation, or a signed-in screen says "not signed in" | `bot-service`'s `session/chat-access.ts` — refreshing **rotates**, so a rotation that was not written back leaves the chat holding a spent token                                                             | the flow that showed the screen      |
| a caller silently stopped passing something after a signature changed                 | every call site of that symbol — `grep -rn` the name before trusting any of them; a green suite proves nothing here, because a path nobody listed is a path nobody wrote a test for (`00-PROTOCOL.md` §6.2b) | the callee, whose own tests all pass |
| a scheduled job never runs, or runs when it was switched off                          | `shared-core/src/lib/automation/schedule.ts` — `workerIsDue` / `workerIsRunnable` are the only place `isActive` and the three schedule shapes are read, for the tick publisher and the admin surface alike    | the job's own class                  |
| a schedule an admin typed was accepted and then never ran                             | `auth-service/src/app/automation/worker-admin.service.ts` — it refuses a shape that could never run, so a row that got in either predates F-031-b or was written by hand; `GET /admin/workers` answers its `shapeError` | the tick publisher                   |
| a job ran but left no `bot_execution_log`, or one that never finished                 | `worker-service/src/app/automation/tick.consumer.ts` — the row is opened before the handler and closed in both paths                                                                                         | the publisher                        |
| a workspace-library import resolves in tests but the service will not boot            | the app's `webpack.config.js` — `TsconfigPathsPlugin` is what makes `@txnet-backend/*` resolve; `transpileOnly` hides its absence until runtime                                                              | the library                          |
| works locally, fails deployed                                                         | `.env` / `.env.dev` / `.env.prod` layering, `dev-docker/`, `swarm/`                                                                                                                                          | any unit at all                      |

Two rules that matter more than the table:

- **Read the role, not the folder.** One file per hop. If the file you predicted
  does not hold the bug, that is information — say so out loud and pick the next
  role deliberately. It is not licence to open the other nine.
- **A symptom that fits no row is a finding.** Either this table is missing a
  row (add it) or the unit is doing something its file names do not admit to,
  which is a `CONVENTIONS.md` problem, not a debugging one.

## Commits

`feat(identity): ...` — scope is the **unit id**, always. Body carries
`spec: F-0207`. Then `git log --grep 'spec: F-0207'` answers "when was this
built, and by which change" without anyone maintaining a link.

## What this buys

| question                                    | answered by                                             | cost                   |
| ------------------------------------------- | ------------------------------------------------------- | ---------------------- |
| where does unit `X` live?                   | its `source:` globs (mirror rule where code exists yet) | zero — it is derivable |
| where is the thing the user just described? | `tools/where.py "<their words>"`                        | one command            |
| which code proves feature `F-xxxx`?         | backlog `proof` column + `git log --grep`               | zero                   |
| did this change break a consumer?           | `depends_on` reverse lookup                             | one grep               |

## What breaks it

- A folder that is not a unit and not under one of the roots above. If it needs
  a home, it needs a unit — or it belongs inside an existing one.
- A shared `util/`/`lib/` folder that grows business rules. The moment a rule
  lands there it is a `platform/` unit with a contract, or it goes back where it
  came from.
- A Next.js component reaching `auth-service` or the database directly instead
  of through the documented HTTP contract. Cross-unit access goes through
  `contract.md` (`00-PROTOCOL.md` §8). No exceptions, no shortcuts.
