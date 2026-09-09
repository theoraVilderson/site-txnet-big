---
id: adr-0029
status: accepted
updated: 2026-09-09
---

# ADR 0029 — Access is resolved per request, not baked into the token

- **Status:** accepted
- **Date:** 2026-09-09
- **Affects units:** governance, identity, forward-auth, auth-api

## Context

What a user may do is specified as three things, not one: their base RBAC role
(`identity`), temporal grants that expire (`governance.temporal_access_grant`),
and restrictions or caps placed on them (`governance.user_restriction`).

Today only the first exists in the access token, as `permissions[]` (ADR-0004).
The open question since 2026-09-04 has been where the other two are evaluated:
folded into the token at mint time, or read per request.

The deciding case is revocation. An access token lives `JWT_ACCESS_TTL_SEC`
(default 900s). If a suspension or an expired grant is baked into the token,
then suspending an abusive account, or letting a two-day grant lapse, takes
effect up to fifteen minutes late — and "up to fifteen minutes late" is the
same sentence as "the fraud response does not work", which is why `fraud`'s
automatic actions exist at all.

## Decision

The token keeps carrying the **base role and its permissions** and nothing
more. Temporal grants and restrictions are resolved **per request**, by a
shared guard, against the current state.

- `forward-auth` is unchanged: it validates the token and the session marker at
  the edge (ADR-0004, ADR-0013). It does not learn about grants.
- The per-request check lives in the application, next to the route that needs
  it, because a restriction is a business rule and the edge holds none.
- A resolved decision may be cached in Redis for a short TTL keyed on the user,
  and any write to a grant or a restriction invalidates that key explicitly —
  the same shape `tenant`'s host cache took in ADR-0025, and for the same
  reason: a TTL is a backstop, never the mechanism.

## Consequences

- One extra read per guarded request, and a real cache-invalidation obligation
  on whoever writes grants and restrictions. Stated here so it is not
  rediscovered later as a bug.
- Suspension is immediate rather than eventually consistent, which is what the
  `fraud` unit's automatic actions assume.
- The token stays small and stable, so nothing has to be re-minted when a grant
  is issued or a cap changes.
- This does not create the guard. `governance` is still `draft`; this ADR says
  what shape it must take when it is built.
