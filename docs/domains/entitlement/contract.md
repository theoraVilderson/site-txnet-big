---
id: entitlement
layer: domain
status: draft
version: 1
updated: 2026-09-14
---

# Contract — entitlement

**DRAFT — intended, nothing built.** Spec: catalog §4.4–4.6
(`tools/spec.py --section 4.4`). Decision: ADR-0049.

## TL;DR

A user's access to anything is one question: **does an active Grant with this
feature key exist?** A Grant is issued from a catalog variant (its quotas,
duration and feature keys copied at issue), moves one way through its states,
and changes its quota only through `quota_adjustment` rows.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| issue | userId, variantId, source, startsAt? | Grant | sync, inside the caller's transaction | variant not found / not assignable |
| transition | grantId, to-status, reason | Grant | sync | illegal transition |
| has active grant | userId, featureKey | boolean (+ the Grant) | sync | — |
| adjust quota | grantId, metric, delta, source, expiresAt? | QuotaAdjustment | sync | Grant not active |
| rotate subscription token | grantId (its owner) | new token | sync | — |

In-process calls from `billing-service` modules (ADR-0049); HTTP routes are
added only when a row needs them.

## Emits (events)

None yet.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| catalog | a variant's quotas, `durationDays`, `billingMode`, feature keys, visibility | cannot issue |
| tenant | the ambient tenant (ADR-0024) | refuses |

## Guarantees (intended)

- `status`: `pending → active → (suspended | exhausted | expired | cancelled)`;
  only `suspended → active` goes back. An exhausted or expired Grant never
  returns — a recharge is a new Grant or a `quota_adjustment`.
- `source` in {`purchase`, `admin_grant`, `coupon`, `affiliate_reward`,
  `migration`, `trial`, `rollover`}.
- `endsAt = null` is permanent access. Quota sits on the Grant, never on a
  config (§4.6).
- `subscriptionToken` is 32 random bytes, rotatable by its user.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
