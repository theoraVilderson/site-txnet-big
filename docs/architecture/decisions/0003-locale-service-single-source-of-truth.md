---
id: adr-0003
status: accepted
updated: 2026-09-04
---

# ADR 0003 — locale-service is the single source of truth for translations

- **Status:** accepted
- **Date:** 2026-09-04 (documented; predates this doc)
- **Affects units:** i18n, auth-api, panel-web, forward-auth

## Context

Backend and frontend both need translations. Copying `locales/*.json` into each
service means N drifting copies and a redeploy per string fix.

## Decision

`locale-service` (Go, gRPC) reads the `locales/` tree and is the **only** reader
of those files at runtime. Every consumer opens a gRPC connection, blocks until
the first `GetSnapshot` is cached, then stays on a `Watch` stream so edits reload
live. There is **one** shared Go client (`i18n-platform/clients/go`, via
`go.work` / `replace`) and **one** shared Node client (`@txnet/locale-client`,
shipped as `vendor/locale-client.tgz`). Snapshot keys are flat dot-notation;
Node adapters re-nest where a tree is needed.

## Consequences

- Positive: one fix reaches every service; live reload; no file IO in app code.
- Negative / accepted cost: `locale-service` is a boot-time hard dependency;
  consumers fail fast if it is unreachable.
- Forecloses: per-service local overrides of a string.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Bundle JSON into each image | drift, redeploy per string |
| Shared npm/Go package of strings | still a rebuild per change; no live reload |
| REST endpoint instead of gRPC stream | no push; polling |

## Revisit trigger

A consumer that must work fully offline, or translation volume that makes full
snapshots per change too heavy (move to deltas).
