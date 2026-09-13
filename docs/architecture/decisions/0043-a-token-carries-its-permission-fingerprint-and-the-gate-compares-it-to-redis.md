---
id: adr-0043
status: accepted
updated: 2026-09-13
---

# ADR 0043 — A token carries its permission fingerprint, and the gate compares it to Redis

- **Status:** accepted
- **Date:** 2026-09-13
- **Affects units:** identity, auth-api, forward-auth, redis-keyspace, panel-web

> **Amended 2026-09-13 (F-101-d, D-30) — SuperAdmin holds `*`.** The policy
> file is still the ceiling, but for one role the ceiling is "everything": its
> entry is `- *`, and the database grants it the single permission `*`, so a
> permission a feature adds reaches SuperAdmin with no edit anywhere. Every
> check reads `*` through one helper — `RolePolicy.Allows` in Go,
> `holdsPermission` in shared-core — and only the bare `*` is a wildcard.
> `tools/contracts.py` fails if any other role carries it, or if a TypeScript
> check reads a permission list without the helper. The price, accepted on the
> user's call: a sensitive permission added later is SuperAdmin's without
> review. Tenant and person scoping is not a permission and is untouched.

## Context

The user asked for a change to a role's permissions to be visible at once
(D-29). Until now an access token carried `permissions[]` for its whole life
(`JWT_ACCESS_TTL_SEC`, 900s), and every consumer read that list: `forward-auth`
checks it against the policy file (ADR-0037) and forwards it, `PermissionsGuard`
reads it inside `auth-service`, and `GET /auth/me` answers it (F-097).

Three facts decide the shape.

**The screen and the gate must move together.** F-097 pinned that `me` answers
the token's list, because a `me` that read the database while the gate read the
token would offer buttons the gate refuses. "Instant" therefore cannot be a
change to `me` alone; it has to reach every reader of the token.

**Nothing in the application writes permissions.** No code creates
`role_permission` rows or changes `user.roleId` after registration; both change
by SQL or migration. A version bumped by "whatever edits a role" would have no
caller.

**The policy file stays the ceiling** — the user's call. A database write alone
can never grant a key the checked-in YAML does not hold.

## Decision

1. **A token carries a fingerprint of its role's permission set**, `permHash`:
   a SHA-256 over the sorted keys, computed by `TokenService` from the rows it
   already loads to mint. A content hash rather than a counter: two writers
   cannot race it, and reverting a set restores the old value.
2. **Redis holds the current fingerprint per role** (`role:<roleId>:permissions`)
   and **the current role per user** (`user:<userId>:role`). The second is needed
   because moving a user to another role leaves the old role's fingerprint
   untouched.
3. **`forward-auth` and `AuthGuard` compare on every request**, beside the session
   lookup they already do. A mismatch answers 401 with `auth.permissionsChanged`
   and `error.reason = "permissionsChanged"` — a machine-readable reason, because
   `msg` is translated. **A missing key is not a mismatch**: shipping the check
   logs nobody out, and a Redis flush degrades to the old behaviour, never to a
   mass refusal. The session check is unaffected by that rule.
4. **The writer is Postgres itself.** A trigger on `role_permission` and on
   `user.roleId` calls `pg_notify`; `auth-service` holds one `LISTEN` connection,
   recomputes the affected fingerprint (or writes the user's role) and `SET`s it.
   On boot it recomputes every role, covering changes made while it was down.
   Replicas all listen; the write is idempotent. This needs a direct connection —
   no transaction-mode pooler sits in front of Postgres in `dev-docker` or `swarm`.
5. **A client that sees the reason refreshes once and retries.** `/auth/refresh`
   re-reads the role from Postgres, so the new token is current. The panel then
   re-reads `me`. The bot needs nothing: `ChatAccess` refreshes before every call.

## Consequences

- "Instant" means the caller's next request after the notification lands.
  An idle open panel changes its menu when it next calls, not by itself.
- A grant beyond the YAML still refuses every request that user makes, now
  immediately rather than after the token expires. The YAML changes first.
- Ship order is part of the decision: the check (inert without keys), then the
  panel's retry, then the writer. The writer first would turn the first key it
  writes into an error on every open panel's next call.
- Not chosen: permissions read from Redis per request with no list in the token
  (a token-shape break across Go, Nest and billing), and revoking the sessions of
  a changed role (instant, but it signs everyone out). Polling every 5s was the
  rival writer; the trigger won as the one that is actually instant.
