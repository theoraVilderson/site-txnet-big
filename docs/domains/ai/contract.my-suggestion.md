---
id: ai
layer: domain
status: draft
version: 2
updated: 2026-10-02
---

# Contract — ai: the user's own suggestion (F-038-h)

ai-service's first routes reached through Traefik (user, 2026-10-02): the
panel's suggestion card ([panel-web/contract.suggestion.md](../../interfaces/panel-web/contract.suggestion.md)).
`decision/my-suggestion.ts`, `…/my-suggestion.controller.ts`. Its own file:
[contract.md](contract.md) is at its ceiling.

## Provides

| Operation | Route | Output | Errors |
|---|---|---|---|
| the current suggestion | `GET /api/ai/me/suggestion` | `{ suggestion: { actionId, actionType, label: 'suggestion', grantId, variantId, fromVariantId, deadline } \| null }` | 401 no gate identity; 429 |
| close it | `POST /api/ai/me/suggestion/:actionId/dismiss` | `{ dismissed }` — false if it was no longer `sent` | 404 not the caller's; 429 |
| never this type again | `POST /api/ai/me/suggestion/:actionId/opt-out` | `{ actionType }` — the tap (F-1505, contract.md "The tap") | 404 not the caller's; 429 |

## Rules

1. **The caller is the gate's.** `IdentityMiddleware` (`api/ai/{*path}`)
   reads `X-User-Id` / `X-Tenant-Id` from `my-auth` and opens that tenant's
   scope; no route takes a user or a tenant. An action is found only as that
   user's own (invariant 14's rule), else 404.
2. **Current** = the newest `sent` suggestion of the last 7 days, not
   converted (F-038-i), its deadline not passed, of a card type (`renew`,
   `resize_up`, `resize_down`), naming a plan (`suggest_variant`); else null.
3. **Dismiss** is `sent` → `dismissed` (`outcomeAt`), the type left open — the
   cooldown (F-1504) already holds it 14 days from the send.
4. **Status and limits.** `TenantStatusGuard` (C-11): the read is `read`; both
   writes are `account` — the user's own, open while a reseller is suspended
   (F-018-p). `RateLimitGuard`: `AI_SUGGESTION_READ` (120 / 15 min) and
   `AI_SUGGESTION_WRITE` (30 / 15 min), per user.
5. **Routing.** Traefik `PathPrefix(/api/ai)` behind `strip-fake-headers,
   my-auth` (`dev-docker/compose/ai-service.yml`); `/api/internal/ai/*` does
   not match it and stays reachable only on the private network.

## Proof

`decision/my-suggestion.spec.ts`: the current-card rule, and every route
acting as the gate's user (404 for another's action).
