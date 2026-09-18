---
id: panel-web
layer: interface
status: active
version: 20
updated: 2026-09-18
---

# Contract — panel-web: resellers (F-018-k)

A topic file of [contract.md](contract.md) (§10). One page, `/resellers`
(`PANEL_RESELLERS`), under `(panel)/resellers/`: `page.tsx` a server shell,
`_components/ResellersView.tsx` the list, `CreateResellerSheet.tsx` and
`ResellerSheet.tsx` the two sheets, `_lib/resellers.ts` the rules. The API is
`lib/tenant-api.ts` over `/api/tenants` and `/api/tenant-packages`
(tenant-service), plus `billingApi.adjustTenantWallet` over
`/api/billing/tenant-wallets/:tenantId/adjustments`. The routes and every rule
behind them are [tenant/contract.admin.md](../../domains/tenant/contract.admin.md)'s
(F-018-c/d/e/f) and [tenant/contract.billing.md](../../domains/tenant/contract.billing.md)
"Manual adjustment" (F-019-a).

## Rules

1. **The platform owner's alone, by two conditions.** The menu entry (top level,
   after the financial group) `requires: ["tenant.manage"]` **and**
   `tenantTypes: ["platform_owner"]`: a reseller administers its own roles and
   can grant itself the key. The page applies the same pair
   (`canAdministerResellers`) before its first read; tenant-service's
   `not_platform_owner` is still the boundary.
2. **The adjustment needs its own key.** The adjust section is shown only with
   `tenant_billing.adjust` on the platform owner's tenant (`canAdjustWallet`),
   and never on a terminated reseller. It is on the reseller's sheet — there is
   no separate adjustment page.
3. **One sentence per refusal.** `REFUSAL_KEYS` covers the union of
   `ResellerRejection`, `TenantSubscriptionRejection`, `TenantStatusRejection`
   and `TenantBillingAdminRejection`; the test reads all four from source.
4. **Every choice is one the service takes.** Periods and reserved slugs are
   test-checked against `reseller.schema.ts`. A package is offered for a period
   only when priced for it, and only while active — or when the reseller is
   already on it (`packageChoices`). `trial` is never offered; nothing is
   offered once `terminated`; `suspended` stays on offer for a suspended
   reseller, which is how a non-payment suspension becomes a manual one
   (F-018-s) — the service answers `status_unchanged` when it already is.
5. **Terminating is asked twice.** A checkbox on the page, because the service
   makes it final and nothing undoes it.
6. **One `requestId` per filled adjustment form.** Minted when the form is
   filled or edited, not per click, so a resend after a lost answer is
   `duplicate_request` rather than a second movement.
7. **No figure is computed here.** Every write re-reads the reseller; the
   balance is `billingBalance`, the period end `currentPeriodEnd`. A
   `subscription_not_found` read is "not on a package yet", not a failure.
8. **Paging is newer/older.** `GET /api/tenants` answers a page with no total;
   "older" is offered while a page comes back full. The page is `?page=`.
9. **The owner is named by user id.** tenant-service never creates a user
   (ADR-0058 (4)); there is no user search behind this page yet.
