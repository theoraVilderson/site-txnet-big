---
id: adr-0036
status: accepted
updated: 2026-09-11
---

# ADR 0036 — A string that crosses a process boundary has one declared home

- **Status:** accepted
- **Date:** 2026-09-11
- **Affects units:** redis-keyspace, forward-auth, i18n, auth-api, panel-web, automation

## Context

An inventory on 2026-09-11 found the same string spelled independently in Go,
in TypeScript and in Traefik YAML, with nothing checking that the copies agree.
Three families, each with a live symptom:

- **Redis keys.** Four per-app `redis.keys.ts` builders with overlapping
  families; `auth-handler` has no builder at all and hand-writes
  `h.keyPrefix + "session:" + claims.SessionID`. The keyspace prefix algorithm
  is written twice, once in Go (`config.go` `buildRedisKeyPrefix`) and once in
  TypeScript, plus a third transcription of the Go function inside a TypeScript
  spec, all kept in step by comments. The prefix *value* disagrees with itself:
  code defaults `v1`, `.env` says `v2`, `docker-compose.main.yml` defaults `v3`
  across five services. Which one wins depends on whether `.env` reaches a
  given container, so the fleet may already be split across two keyspaces —
  precisely the failure C-03 exists to prevent.
- **i18n keys.** Roughly 207 keys at 500 call sites, every one a bare literal.
  Both clients return the key itself when it is missing and never throw, so a
  typo is invisible at runtime. Generators exist under `i18n-platform/codegen/`
  and are wired to nothing: their output directory is gitignored, no Makefile
  target builds it, no CI job runs it.
- **HTTP headers, the refresh cookie, permissions, the AMQP exchange.** The
  seven identity headers are spelled in the Go writer, in the TypeScript
  reader and twice more in Traefik labels. `X-Actor-Id` sits in the Traefik
  strip list while nothing writes or reads it — the lists have already drifted.
  `refresh_token` has twelve spellings across three apps.

The cost is the one the user named: renaming any of these means hunting the
whole tree by hand and missing some.

One mechanism in this repo already solves this and is the only cross-language
contract enforced by anything other than a comment: `contracts/jwt/ts-to-go.json`,
a fixture written by `token.contract.spec.ts` and read by `contract_test.go`,
pinning the JWT claim names.

## Decision

**A string that crosses a process boundary has exactly one declared home.
Everything else imports it. Where an import is impossible — Go to TypeScript to
Traefik YAML — a checked-in fixture plus a test on each side replaces the
import.**

| family | home | how the other side is held to it |
|---|---|---|
| Redis keys, prefix, TTLs | `shared-core/src/lib/redis/` | `contracts/redis/keyspace.json` + a Go contract test |
| HTTP headers, cookies, permissions | `contracts/http/wire.json` | a Go test, a TypeScript spec, and `tools/contracts.py` for the YAML |
| i18n keys | `locales/**`, read from disk by the existing generators | committed generated constants, freshness gated in CI |
| tunables | `shared-core` or `.env` | the `configKey` plumbing that already exists |

Three sub-decisions, recorded so no later session re-opens them.

**A `CONVENTIONS.md` check block cannot express any of this.**
`tools/conventions.py` supports only per-file `forbid:` / `require:` regexes and
has no cross-file or set-comparison capability. Check blocks stay good at
forbidding a *shape* — a raw template-literal key, a bare bucket string. Any
claim that two files agree needs a test or a tool. That is why
`tools/contracts.py` is a sixth gate rather than another check block.

**The header fixture is hand-written, not generated.** Traefik's strip and
forward lists live in YAML with no toolchain that could consume a generated Go
or TypeScript file, so the source must be a format all three consumers read. It
is nine strings; a generator would be more machinery than content.

**The i18n generators read `locales/` from disk, not a running
`locale-service`.** ADR-0003 makes the service the source of truth for
*serving*; the files are the source of truth for *what exists*. Reading the
directory loses nothing and is what makes generation hermetic enough to be a CI
gate.

**The keyspace version unifies on `v2`** — the `.env` value — on the user's
call 2026-09-11, so sessions currently live in dev survive the change.

## Consequences

- Positive: renaming a key, a header or a cookie is one edit plus a red test
  everywhere else that still spells the old one. That is the whole point.
- Positive: the Go/TypeScript prefix drift becomes impossible rather than
  merely commented against, and `goBuildRedisKeyPrefix` — a TypeScript
  transcription of a Go function — is deleted rather than maintained.
- Negative: three new artifacts to keep honest (`contracts/redis/keyspace.json`,
  `contracts/http/wire.json`, the committed i18n constants) and a sixth gate in
  CI. A fixture nobody regenerates is worse than no fixture, so each is written
  by a test rather than by hand wherever a test can.
- Negative: the i18n half adds a build step and a committed generated artifact,
  which the repo has avoided so far.
- **Operational:** bumping `REDIS_KEYSPACE_VERSION` is a forced logout of every
  session — that is what the value is *for* (C-03). It follows that every
  service and `auth-handler` deploy together; a rolling deploy across a version
  change is a partial outage by construction.

## Alternatives considered

- **Generated constants per language for every family.** Right for i18n, where
  the list is 207 keys and mechanical. Wrong for nine headers and one cookie,
  where the generator would outweigh the content.
- **A check block comparing the two spellings.** Structurally impossible, see
  above.
- **Leaving the comments and being careful.** This is the status quo, and the
  `v1`/`v2`/`v3` split plus the dead `X-Actor-Id` entry are the evidence it
  does not hold.
