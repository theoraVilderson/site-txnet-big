---
id: adr-0004
status: accepted
updated: 2026-09-04
---

# ADR 0004 — Stateless HMAC JWT + Redis session-revocation, checked at the edge

- **Status:** accepted
- **Date:** 2026-09-04 (documented; predates this doc)
- **Affects units:** identity, auth-api, forward-auth, redis-keyspace

## Context

Every request to a protected service needs an auth decision without a Postgres
round-trip, but logout / password-change / ban must take effect immediately.

## Decision

Access tokens are short-lived JWTs signed with **HMAC-SHA256** (hand-rolled in
both `token.service.ts` and Go `jwt/validator.go` — no JWT library; the verifier
always uses HS256 regardless of the token header, blocking `alg` confusion).
Claims carry `sub`, `tenantId`, `roleId`, `permissions`, `sessionId`,
`isImpersonated`. A **Redis marker per `sessionId`** is the fast revocation
check; Postgres `Session` is the record. `auth-handler` (Traefik ForwardAuth)
validates signature + expiry + Redis session + RBAC, then sets `X-User-Id`,
`X-Tenant-Id`, `X-Role-Id`, `X-User-Permissions`, `X-Impersonated*` for upstream
services. Refresh tokens are opaque random strings, stored only as an HMAC hash.

## Consequences

- Positive: O(1) auth, instant revocation, upstream services trust headers only.
- Negative / accepted cost: one HMAC secret shared by auth-service and
  auth-handler; a Redis outage fails auth closed; permissions are baked into the
  token until it expires.
- Forecloses: asymmetric multi-issuer tokens without a redesign.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Pure stateless JWT, no revocation list | cannot force logout / ban |
| DB session lookup per request | latency, couples every service to Postgres |
| RS256 + JWKS | extra moving parts for a single internal issuer |

## Revisit trigger

A third independent service issuing tokens, or a need to rotate signing keys
without a coordinated deploy.
