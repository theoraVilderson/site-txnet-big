---
id: billing
layer: domain
status: active
version: 4
updated: 2026-09-28
---

# Contract — billing / gateway management

A topic file of `contract.md` (§10): creating, changing and deleting a payment
gateway, and the quick amounts a top-up page offers. Two surfaces, one set of
rules. Taking a payment through a gateway is [contract.deposit.md](contract.deposit.md);
lending one to another tenant is `domains/audit/contract.settlement.md`.


`/api/billing/coupons` (`payment/coupon-admin/`): coupons, gift-code batches, usage — `contract.coupon.md`.
`/api/billing/gateways` (`payment/gateway-admin/`): `GET` list, `POST` create,
`PATCH` / `DELETE :source/:id`, `GET` / `PUT presets` — the caller's own
default quick amounts (F-092-v), `{presets, currencyCode}` — and `GET` / `PUT tax` — its default tax on a
top-up, `{taxRatePercent}` (F-104-ag). Behind `gateway.manage`; the permission is not
the boundary. Linking a gateway to another tenant is the settlement grant
(`domains/audit/contract.settlement.md`), not this surface.

| Rule | Why |
|---|---|
| The platform owner manages every gateway; any other tenant only its own `tenant_gateway_config` rows. Anything else is `gateway_not_found` | a reseller who could edit another's gateway could point its merchant id at its own account; a 404 does not confirm the row exists |
| **A tenant's gateway is its own** (F-104-ak, the user's call 2026-10-08): switched on, it is offered — no approval, and a new secret or provider resets nothing. `verificationStatus` is retired: nothing reads or writes it | the reseller answers for its own merchant account; an approval nobody is told about only kept working gateways from its customers |
| **The platform owner's lever is a block** (F-104-ak): `blockedReason` on a tenant gateway's edit — a reason sets `blockedAt` / `blockedReason` / `blockedByAdminId`, `null` clears them; anyone else, or on a platform gateway, `block_is_platform_owners`. A blocked gateway is offered to nobody, a manager testing it included, and its delete is `gateway_blocked`. Payments already started on it still settle | the platform keeps the power to stop a gateway that takes money it should not; deleting and re-adding it must not lift the block |
| `merchantId` / `secretKey` / `webhookSecret` are relayed to `tenant-service` (`VaultSecretClient` → F-102-a, F-018-ab) and appear in no answer, audit row or column; answers carry `credentials` as `{configured, version, rotatedAt}` | write-only secrets (ADR-0026 guarantee 1); `billing` still loads the vault read-only |
| Each provider's secrets and required settings are one exhaustive map, `payment/gateway/provider-fields.ts` (F-104-e, D-32). A missing **secret** is never refused — the gateway may be saved and switched on, and the answer's `missingSecrets` names what is still needed (`null` when the state could not be read). A `telegram_stars` gateway needs a positive `staticRate` (its USD value per Star) or `missing_field`, and is stored with `useLiveRate` off | the user's call, 2026-09-16: a heads-up, not a wall; a Star has no live rate |
| The pool follows the caller (ADR-0053): the platform owner on the cross-tenant pool, anyone else in a `tenantTransaction` on the app pool. A lent gateway's payments and grants in other tenants are reached only through `billing.gateway_usage` / `billing.withdraw_gateway_grants` (SECURITY DEFINER, `20260917000200_gateway_release`), which refuse a gateway that is not the caller's own; a platform gateway is the cross-tenant role's alone | strict RLS stands behind a reseller's filter; releasing one's own lent gateway needs counts and a withdrawal, not another tenant's rows |
| Delete (the user's calls, 2026-09-17): refused `gateway_has_open_payments` while any payment on it is `pending`/`expired` inside `RECONCILIATION_LOOKBACK_SEC`, in any tenant — deactivate first. Otherwise a row nothing ever pointed at is deleted; one a payment or grant (even withdrawn) points at is deactivated and its live grants withdrawn, with a `gateway_grant_withdraw` audit row in each borrower's tenant. Deactivating (`isActive`) leaves grants alone; a borrower's coupons naming the gateway are left as they are | ADR-0041 §6; a borrower's payer still waiting must not lose the gateway |
| The order inside delete (F-104-t): `isActive` off **first**, committed with the open-payment count, before a secret is touched; the count is then taken again, and a payment that started in between refuses the delete — `gateway_has_open_payments`, gateway left deactivated, secrets untouched, one `gateway_delete` audit row saying `{mode: deactivated, openPayments}`. Secrets are revoked after that second count, before the delete or the grant withdrawal | between count and revoke the gateway was still selectable: that top-up is paid into a gateway whose `webhook_secret` is gone a moment later, so the door answers 401 and reconciliation gets `CredentialUnavailable` — money in, creditable only by hand. Switching off closes the door; a failure part-way still leaves a gateway that cannot charge |
| Quick amounts (F-092-v): a gateway's `depositPresets` overrides the tenant's `presets` (`billing.deposit_setting`); both written through `deposit-presets.ts` — positive, 2 decimals, unique, ascending, at most 8; empty inherits. A default-list write is audited `deposit_presets_update` | one rule for both lists; the top-up page never judges a list |
| Tax on a top-up (F-104-ag, ADR-0076): a gateway's `taxRatePercent` overrides the tenant's default on `billing.deposit_setting` (`PUT tax`, required key, `null` = no tax); a gateway's `null` inherits. Both 0..100, else `invalid_range` naming `taxRatePercent`, before anything is written. The default is audited `deposit_tax_update` in the same transaction, and writes the rate alone — the quick amounts on the same row are untouched; a gateway's rate lands in its `gateway_update` row | the same two levels as quick amounts; the migration's CHECK stands behind it, but a CHECK answers a typo with a 500 |
| Every decimal is refused finer than the column that stores it (F-104-ad): `minAcceptAmount`, `maxAcceptAmount`, `feeFloor`, `feeCeiling` and the quick amounts at the columns' 4 — and the gateway currency's own places by the service, `invalid_range` / `invalid_presets` naming the field (`gateway-fields.ts`, F-116-r) — 4 for `feeValue` and `taxRatePercent`, 8 for `roundingStep`, 18 for `staticRate` / `minRate` / `maxRate` / `fixedAmountModifier` (`DECIMAL(30,18)`, 12 whole digits: a currency change divides them, F-116-f, and the editor must save back what it read). The message names the field and its places; the panel's form refuses the same values before the request — `taxRatePercent` too, on a gateway and on the default (F-104-aj, `taxRateError`) | a `numeric` column rounds a place past its scale away instead of refusing it, so a `feeCeiling` of `0.125` was stored as `0.13` and the operator was told nothing — money nobody asked for is not ours to round (the user's call, 2026-09-20) |
| A gateway view carries `currencyCode`, the gateway's own: what its limits, fixed fee, fixed modifier and presets are in; the presets answer names the default list's, the tenant's now when none is saved yet (F-116-h2) | ADR-0098 part 3: a currency change converts these, and the panel cannot tell 5 USD from 5 IRR without it |
| Every write lands with its `admin_audit_log` row (`gateway_create` / `_update` / `_delete`) in one transaction | who changed a gateway is the question after money went somewhere unexpected |

Refusals name their `reason`: 403 `not_platform_owner`, `block_is_platform_owners`;
404 `gateway_not_found`, `tenant_not_found`; 409 `provider_already_configured`, `gateway_has_open_payments`, `gateway_blocked`;
400 `invalid_range`, `missing_field`, `invalid_presets`, `invalid_callback` (`callbackUrl`, F-092-w: absolute http(s), ≤500, `null` clears); 502 `secrets_unavailable`.
A manual gateway's body and destinations add 400 `manual_setting_mismatch`, `invalid_manual_setting`, `automatic_unavailable`, `invalid_destination`; 404 `destination_not_found`; 409 `kind_in_use` — [contract.manual-transfer.md](contract.manual-transfer.md) "Gateway admin" (F-803-c). Proof:
`gateway-admin.service.spec.ts`, `gateway-admin.schema.spec.ts`, `deposit-presets.spec.ts`, `vault-secret.client.spec.ts`, `gateway-grant-schema.int.spec.ts` (the two functions).


## Who a gateway is offered to (built — F-102-g)

`PUT :source/:id/audience` `{userGroupIds: uuid[] ≤ 50}` on both surfaces (the
named reseller's included) → `{userGroupIds}`; every gateway view carries
`userGroupIds`. Asked by the user 2026-10-08; the three open calls were taken
on the recommendation when the user said to carry on (backlog F-102-g).

| Rule | Why |
|---|---|
| No group = everyone, as before. Groups = only a user who is a **user** member of at least one (`admittedByAudience`, shared-core `catalog/audience.ts` — a product's audience asks it too, PT-1-b) — a group's reseller members do not count | the same reading a discount rule's group has (`contract.purchase.md`); one meaning of "in this group" everywhere |
| The set is replaced whole; `[]` opens the gateway to everyone again. A group not the gateway owner's is `group_not_found` (404) before anything is written, one added that the caller may not pick `audience_not_allowed` (403, ADR-0143, governance "A group as an audience"); `billing.gateway_audience`'s composite keys refuse it again, and a trigger keeps a platform gateway to the platform owner's groups. One `gateway_update` audit row `{userGroupIds}` in the owner's tenant | the owner is the row's tenant — the platform owner setting a reseller's gateway picks that reseller's groups, never its own |
| Applied where a payer is named, in `selectableGateways` / `selectGateway`: the top-up list, quote and start, and "another gateway" (F-038-m). A gateway outside the payer's groups is not listed, and naming it anyway is `DepositGatewayNotFound` — never a refusal of its own | a separate refusal would tell a user there is a better gateway kept from them |
| Not applied with no payer: a reseller's billing top-up and the currencies a tenant may pin are tenant-level. Not applied to a **granted** gateway (ADR-0041): its audience rows are its lender's groups, holding the lender's users; the grant is the lever there | a lender's groups say nothing about a borrower's customers |
| A group a gateway names cannot be deleted: `group_in_use` (Restrict), as for a discount rule | a deleted group would silently open the gateway to everyone |

Proof: `gateway-admin.service.spec.ts`, `deposit-quote.service.spec.ts`,
`deposit-start.service.spec.ts`, `deposit-gateways.int.spec.ts` (RLS, the keys, the trigger).

## A named reseller's gateways (built — F-066-w3, ADR-0064)

`/api/billing/tenants/:tenantId/gateways` (`payment/gateway-admin/reseller-gateway.*`):
the same list, create, edit, delete, presets and tax, for the reseller the **path**
names — the surface a reseller's console configures it through (F-066-w4). The
ambient route above is untouched and stays what a tenant configuring *itself*
uses. Shaped identically, `:source/:id` included, so one client serves both.

| Rule | Why |
|---|---|
| The door is `ResellerAccess` (tenant invariant 21, `tenant/contract.entitlements.md`) keyed `gateway.manage` (AC-1-e): the reseller's owner, one of its staff seats holding `gateway.manage`, or the platform owner's staff. `read` to list, `staffWrite` to write, judged against the **reseller's** status matrix | a reseller's owner is the platform's customer, not one of its operators, and holds no operator permission |
| The work then runs as the reseller — `ResellerAccess.run` opens its scope and `GatewayAdminService` is called with it as the actor's tenant. Every rule above applies unchanged: its own rows only, the app pool in a `tenantTransaction`, secrets to the vault and never back, `gateway_has_open_payments` on delete, one `admin_audit_log` row per write in the **reseller's** tenant naming the caller as its admin | the rules are not restated here, so the two surfaces cannot drift apart |
| Nothing is elevated by this path: `blockedReason` is `block_is_platform_owners` for everyone here, platform staff included, and a `platform` source is `not_platform_owner` on create and `gateway_not_found` otherwise. Blocking is done on the ambient route, as the platform owner | the actor handed on is a reseller; a staff member who wants the owner's powers uses the owner's surface |
| The tenant is the path's alone — the body has no `tenantId` (`.strict()` refuses one) and the session's is never read | the owner signs in to the platform owner's tenant (ADR-0059), so the ambient id would configure the wrong tenant |
| The two `gateway.admin.*` rate-limit budgets are shared with the ambient surface, per caller | the same person doing the same work; a second budget reached by adding a path segment is no budget |

Refusals add `ResellerAccess`'s four to the list above: 403 `not_allowed`,
`reseller_suspended`; 404 `reseller_not_found` (platform staff only); 409
`reseller_terminated`. Proof: `reseller-gateway.service.spec.ts`.

## Which rate a gateway price reads, and whose (F-116-j)

| Rule | Why |
|---|---|
| **A price inside a tenant's books reads that tenant's pins first**: `FxRateReader.pair(from, to, ratesTenantId)`, given by the caller — a user's top-up quote and start, a purchase's coupon conversion (`CouponRequest.ratesTenantId`) pass the payer's tenant | ADR-0098 part 9, ADR-0101: a reseller in an outage pins the rate its own users pay at |
| **A billing top-up passes none** (`request.billingTenantId` set): money with the platform never reads a tenant's pin. A caller that says nothing gets the platform's rates only | a tenant cannot choose the rate it pays the platform at |
| `GET /api/internal/billing/tenants/:tenantId/charge-currencies`, `ServiceOnlyGuard` (404 without the token): `{currencies}`, the sorted, distinct charge currencies of the tenant's `selectableGateways`, read as that tenant (`chargeCurrenciesOf`) | currency-service's answer to which currencies a tenant may pin besides its operating one (user, 2026-09-28); billing owns gateways and each provider's `chargeCurrency`, so the answer is computed here, never copied |

Proof: `gateway-currency.spec.ts` (a reseller's pin vs a billing top-up;
`chargeCurrenciesOf`), `coupon-currency.spec.ts`.
