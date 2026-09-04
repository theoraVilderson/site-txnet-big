---
id: adr-0008
status: accepted
updated: 2026-09-04
---

# ADR 0008 — One repo: Nx for the Node backend, go.work for Go modules

- **Status:** accepted
- **Date:** 2026-09-04 (documented; predates this doc)
- **Affects units:** i18n, auth-api, forward-auth

## Context

Polyglot codebase (NestJS, Go, Next.js) that shares a Prisma schema, a locale
contract and a Redis keyspace convention. Splitting into many repos would make
those shared contracts drift.

## Decision

Single Git repo. The Node backend is one **Nx workspace** (`txnet-backend/`) with
per-service apps. Go code uses a repo-root `go.work` listing `auth-handler`,
`i18n-platform/clients/go`, `i18n-platform/codegen/go`,
`i18n-platform/services/locale-service`; Docker builds set `GOWORK=off` and rely
on `replace` directives. The Node locale client is distributed as a committed
packed tarball (`vendor/locale-client.tgz`), not a workspace symlink, so
turbopack / webpack / tsc resolve it with zero config.

## Consequences

- Positive: shared contracts change atomically in one commit/PR.
- Negative / accepted cost: heterogeneous tooling in one CI; `make sync-node`
  must be run after editing the Node client.
- Forecloses: independent per-service repo history / access control.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Multi-repo + published packages | contract drift, version churn |
| Go single-module for everything | Docker build contexts and deploy units differ |
| `file:` symlink for the Node client | breaks turbopack/Nx resolution |

## Revisit trigger

A service with a genuinely independent release cadence and team boundary.
