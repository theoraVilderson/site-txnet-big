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
| Only the platform owner sets `verificationStatus`; a tenant changing a verified gateway's secret resets it to `pending_test_transaction`, committed **before** the secret is written | a verified gateway is otherwise a place to swap in an unverified account |
| Changing a verified gateway's `providerName` resets it the same way, whoever makes the change (F-104-x) — unless the patch sets `verificationStatus` itself, which is the platform owner's word and wins. `feeValue`, `callbackUrl` and the other settings leave it `verified` | the test transaction proved one driver; it says nothing about the next one. A fee or a callback address changes nothing it proved |
| `merchantId` / `secretKey` / `webhookSecret` are relayed to `tenant-service` (`VaultSecretClient` → F-102-a, F-018-ab) and appear in no answer, audit row or column; answers carry `credentials` as `{configured, version, rotatedAt}` | write-only secrets (ADR-0026 guarantee 1); `billing` still loads the vault read-only |
| Each provider's secrets and required settings are one exhaustive map, `payment/gateway/provider-fields.ts` (F-104-e, D-32). A missing **secret** is never refused — the gateway may be saved and switched on, and the answer's `missingSecrets` names what is still needed (`null` when the state could not be read). A `telegram_stars` gateway needs a positive `staticRate` (its USD value per Star) or `missing_field`, and is stored with `useLiveRate` off | the user's call, 2026-09-16: a heads-up, not a wall; a Star has no live rate |
| The pool follows the caller (ADR-0053): the platform owner on the cross-tenant pool, anyone else in a `tenantTransaction` on the app pool. A lent gateway's payments and grants in other tenants are reached only through `billing.gateway_usage` / `billing.withdraw_gateway_grants` (SECURITY DEFINER, `20260917000200_gateway_release`), which refuse a gateway that is not the caller's own; a platform gateway is the cross-tenant role's alone | strict RLS stands behind a reseller's filter; releasing one's own lent gateway needs counts and a withdrawal, not another tenant's rows |
| Delete (the user's calls, 2026-09-17): refused `gateway_has_open_payments` while any payment on it is `pending`/`expired` inside `RECONCILIATION_LOOKBACK_SEC`, in any tenant — deactivate first. Otherwise a row nothing ever pointed at is deleted; one a payment or grant (even withdrawn) points at is deactivated and its live grants withdrawn, with a `gateway_grant_withdraw` audit row in each borrower's tenant. Deactivating (`isActive`) leaves grants alone; a borrower's coupons naming the gateway are left as they are | ADR-0041 §6; a borrower's payer still waiting must not lose the gateway |
| The order inside delete (F-104-t): `isActive` off **first**, committed with the open-payment count, before a secret is touched; the count is then taken again, and a payment that started in between refuses the delete — `gateway_has_open_payments`, gateway left deactivated, secrets untouched, one `gateway_delete` audit row saying `{mode: deactivated, openPayments}`. Secrets are revoked after that second count, before the delete or the grant withdrawal | between count and revoke the gateway was still selectable: that top-up is paid into a gateway whose `webhook_secret` is gone a moment later, so the door answers 401 and reconciliation gets `CredentialUnavailable` — money in, creditable only by hand. Switching off closes the door; a failure part-way still leaves a gateway that cannot charge |
| Quick amounts (F-092-v): a gateway's `depositPresets` overrides the tenant's `presets` (`billing.deposit_setting`); both written through `deposit-presets.ts` — positive, 2 decimals, unique, ascending, at most 8; empty inherits. A default-list write is audited `deposit_presets_update` | one rule for both lists; the top-up page never judges a list |
| Tax on a top-up (F-104-ag, ADR-0076): a gateway's `taxRatePercent` overrides the tenant's default on `billing.deposit_setting` (`PUT tax`, required key, `null` = no tax); a gateway's `null` inherits. Both 0..100, else `invalid_range` naming `taxRatePercent`, before anything is written. The default is audited `deposit_tax_update` in the same transaction, and writes the rate alone — the quick amounts on the same row are untouched; a gateway's rate lands in its `gateway_update` row | the same two levels as quick amounts; the migration's CHECK stands behind it, but a CHECK answers a typo with a 500 |
| Every decimal is refused finer than the column that stores it (F-104-ad): 2 places for `minAcceptAmount`, `maxAcceptAmount`, `feeFloor`, `feeCeiling`, 4 for `feeValue` and `taxRatePercent`, 8 for `roundingStep`, 18 for `staticRate` / `minRate` / `maxRate` / `fixedAmountModifier` (`DECIMAL(30,18)`, 12 whole digits: a currency change divides them, F-116-f, and the editor must save back what it read). The message names the field and its places; the panel's form refuses the same values before the request — `taxRatePercent` too, on a gateway and on the default (F-104-aj, `taxRateError`) | `numeric(18, 2)` rounds a third place away instead of refusing it, so a `feeCeiling` of `0.125` was stored as `0.13` and the operator was told nothing — money nobody asked for is not ours to round (the user's call, 2026-09-20) |
| A gateway view carries `currencyCode`, the gateway's own: what its limits, fixed fee, fixed modifier and presets are in; the presets answer names the default list's, the tenant's now when none is saved yet (F-116-h2) | ADR-0098 part 3: a currency change converts these, and the panel cannot tell 5 USD from 5 IRR without it |
| Every write lands with its `admin_audit_log` row (`gateway_create` / `_update` / `_delete`) in one transaction | who changed a gateway is the question after money went somewhere unexpected |

Refusals name their `reason`: 403 `not_platform_owner`, `verification_is_platform_owners`;
404 `gateway_not_found`, `tenant_not_found`; 409 `provider_already_configured`, `gateway_has_open_payments`;
400 `invalid_range`, `missing_field`, `invalid_presets`, `invalid_callback` (`callbackUrl`, F-092-w: absolute http(s), ≤500, `null` clears); 502 `secrets_unavailable`. Proof:
`gateway-admin.service.spec.ts`, `gateway-admin.schema.spec.ts`, `deposit-presets.spec.ts`, `vault-secret.client.spec.ts`, `gateway-grant-schema.int.spec.ts` (the two functions).


## A named reseller's gateways (built — F-066-w3, ADR-0064)

`/api/billing/tenants/:tenantId/gateways` (`payment/gateway-admin/reseller-gateway.*`):
the same list, create, edit, delete, presets and tax, for the reseller the **path**
names — the surface a reseller's console configures it through (F-066-w4). The
ambient route above is untouched and stays what a tenant configuring *itself*
uses. Shaped identically, `:source/:id` included, so one client serves both.

| Rule | Why |
|---|---|
| The door is `ResellerAccess` (tenant invariant 21, `tenant/contract.entitlements.md`) and not `gateway.manage`: the reseller's owner, one of its staff seats holding `tenant.manage`, or the platform owner's staff. `read` to list, `staffWrite` to write, judged against the **reseller's** status matrix | a reseller's owner is the platform's customer, not one of its operators, and holds no operator permission |
| The work then runs as the reseller — `ResellerAccess.run` opens its scope and `GatewayAdminService` is called with it as the actor's tenant. Every rule above applies unchanged: its own rows only, the app pool in a `tenantTransaction`, secrets to the vault and never back, `gateway_has_open_payments` on delete, one `admin_audit_log` row per write in the **reseller's** tenant naming the caller as its admin | the rules are not restated here, so the two surfaces cannot drift apart |
| Nothing is elevated by this path: `verificationStatus` is `verification_is_platform_owners` for everyone here, platform staff included, and a `platform` source is `not_platform_owner` on create and `gateway_not_found` otherwise. Verifying is done on the ambient route, as the platform owner | the actor handed on is a reseller; a staff member who wants the owner's powers uses the owner's surface |
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
