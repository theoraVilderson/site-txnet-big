---
id: entitlement
layer: domain
status: draft
version: 1
updated: 2026-09-14
---

# Contract — entitlement

**Storage built (F-026-b); no service code yet** — issue, transition and check
land with F-026-e. Spec: catalog §4.4–4.6 (`tools/spec.py --section 4.4`).
Decision: ADR-0049.

## TL;DR

A user's access to anything is one question: **does an active Grant with this
feature key exist?** A Grant is issued from a catalog variant (its quotas,
duration and feature keys copied at issue), moves one way through its states,
and changes its quota only through `quota_adjustment` rows.

## Provides (intended, F-026-e)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| issue | userId, variantId, source, sourceReferenceId?, startsAt? | Grant + the subscription token, once | sync, inside the caller's transaction | variant not found / not assignable; already issued for that cause |
| transition | grantId, to-status, reason | Grant | sync | illegal transition |
| has active grant | userId, featureKey | boolean (+ the Grant) | sync | — |
| adjust quota | grantId, metric, delta, source, expiresAt? | QuotaAdjustment | sync | Grant not active |
| rotate subscription token | grantId (its owner) | the new token, once | sync | — |

In-process calls from `billing-service` modules (ADR-0049); HTTP routes are
added only when a row needs them.

## Emits (events)

None yet.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| catalog | a variant's quotas, `durationDays`, `billingMode`, its product's feature keys | cannot issue |
| identity | the user a Grant is issued to | cannot issue |
| tenant | the ambient tenant (ADR-0024) | refuses |

## Consumers

| Unit | What it reads |
|---|---|
| network | `config.grantId`: a config draws on its Grant's quota (F-027) |
| billing | issues a Grant for a `free_grant` coupon (F-502-l) and, later, a purchase |

## Guarantees (built — `entitlement-schema.int.spec.ts`)

| Rule | Held by |
|---|---|
| A tenant reads and writes only its own Grants and adjustments — never shared-read | RLS, strict |
| A Grant's user is its tenant's; its variant is the platform's or its tenant's; an adjustment and a config are their Grant's tenant's (`entitlement_tenant_mismatch`) | trigger `entitlement.same_tenant` |
| `pending → active → (suspended \| exhausted \| expired \| cancelled)`, `pending → cancelled`; only `suspended → active` goes back (`grant_status_one_way`) | trigger |
| The subscription token is stored only as SHA-256 lowercase hex, unique; the token is shown once — at issue and on rotation (`grant_token_hash_shape`) | CHECK + unique index; the user's call 2026-09-14 |
| One cause issues one Grant: `(source, sourceReferenceId)` unique when set | partial unique index |
| A quota adjustment is never changed or deleted; `delta ≠ 0`; a rollover cap is 1..100 % (`quota_adjustment_is_history`) | trigger + CHECKs |
| `endsAt = null` is permanent; when set it is after `startsAt`. Quota sits on the Grant, never on a config (§4.6) | CHECK; schema |

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
