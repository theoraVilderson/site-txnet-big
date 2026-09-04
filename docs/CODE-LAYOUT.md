---
id: code-layout
status: active
updated: 2026-09-04
unit_aliases:
  - identity:auth
  - identity:impersonation
  - auth-api:auth-service
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

| root | holds | mirrors |
|---|---|---|
| `txnet-backend/auth-service/src/app/<concern>/` | NestJS modules for units already live (`identity`) | `docs/domains/identity/`, `docs/interfaces/auth-api/` |
| `txnet-backend/billing-service/src/app/` | billing scaffold (not yet implementing `billing`) | `docs/domains/billing/` (stays `draft` until real) |
| `txnet-backend/prisma/domains/*.prisma` | one schema file per business domain | `owns_tables:` in that domain's `INDEX.md` |
| `auth-handler/internal/` | Go Traefik ForwardAuth gateway | `docs/platform/forward-auth/` |
| `i18n-platform/services/locale-service/` + `i18n-platform/clients/{go,node}/` | gRPC translation source of truth + shared clients | `docs/platform/i18n/` |
| `site-pwa/src/app/` | Next.js user panel (routes, route handlers, components) | `docs/interfaces/panel-web/`, `docs/SURFACES.md` rows |
| `coinsite/src/app/` | Next.js public landing site | `docs/interfaces/marketing-web/`, `docs/SURFACES.md` rows |

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

## Commits

`feat(identity): ...` — scope is the **unit id**, always. Body carries
`spec: F-0207`. Then `git log --grep 'spec: F-0207'` answers "when was this
built, and by which change" without anyone maintaining a link.

## What this buys

| question | answered by | cost |
|---|---|---|
| where does unit `X` live? | its `source:` globs (mirror rule where code exists yet) | zero — it is derivable |
| where is the thing the user just described? | `tools/where.py "<their words>"` | one command |
| which code proves feature `F-xxxx`? | backlog `proof` column + `git log --grep` | zero |
| did this change break a consumer? | `depends_on` reverse lookup | one grep |

## What breaks it

- A folder that is not a unit and not under one of the roots above. If it needs
  a home, it needs a unit — or it belongs inside an existing one.
- A shared `util/`/`lib/` folder that grows business rules. The moment a rule
  lands there it is a `platform/` unit with a contract, or it goes back where it
  came from.
- A Next.js component reaching `auth-service` or the database directly instead
  of through the documented HTTP contract. Cross-unit access goes through
  `contract.md` (`00-PROTOCOL.md` §8). No exceptions, no shortcuts.
