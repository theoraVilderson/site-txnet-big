---
id: panel-web
layer: interface
status: active
version: 20
updated: 2026-09-19
---

# Contract — panel-web: resellers (F-018-k, F-019-k)

A topic file of [contract.md](contract.md) (§10). Two pages under
`(panel)/resellers/`, each a server shell over a client view:

| page | route | files |
|---|---|---|
| the list | `/resellers` (`PANEL_RESELLERS`) | `_components/ResellersView.tsx`, `CreateResellerSheet.tsx` with `OwnerPicker.tsx` |
| one reseller | `/resellers/[id]` (`panelResellerPath`) | `[id]/_components/ResellerDetailView.tsx`, `ResellerLedger.tsx` |

`_lib/resellers.ts` holds the rules of both, `_components/resellers-ui.tsx`
what they share (`StatusBadge`, the refusal sentence). The API is
`lib/tenant-api.ts` over `/api/tenants` and `/api/tenant-packages`
(tenant-service), `billingApi.adjustTenantWallet` and
`billingApi.tenantWalletTransactions` over
`/api/billing/tenant-wallets/:tenantId/…`, and `authApi.searchUsers`
over `GET /api/auth/users` (F-018-ad, [auth-api](../auth-api/contract.md)). The routes and every rule
behind them are [tenant/contract.admin.md](../../domains/tenant/contract.admin.md)'s
(F-018-c/d/e/f) and [tenant/contract.billing.md](../../domains/tenant/contract.billing.md)
"Manual adjustment" (F-019-a) and "The platform owner's read of one reseller"
(F-019-j).

## Rules

1. **The platform owner's alone, by two conditions.** The menu entry (top level,
   after the financial group) `requires: ["tenant.manage"]` **and**
   `tenantTypes: ["platform_owner"]`: a reseller administers its own roles and
   can grant itself the key. The page applies the same pair
   (`canAdministerResellers`) before its first read; tenant-service's
   `not_platform_owner` is still the boundary.
2. **Each billing act needs its own key.** The adjust section is shown only
   with `tenant_billing.adjust` on the platform owner's tenant
   (`canAdjustWallet`), and never on a terminated reseller; the ledger only
   with `tenant_billing.read` (`canReadTenantLedger`) — billing holds the two
   apart, so the page does. Both are the reseller's **billing** tab, and the
   tab itself is offered for either key (`resellerTabs`).
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
9. **The owner is found, not typed** (F-018-ae). With `user.search` on the
   platform owner's tenant (`canSearchUsers`) the sheet searches by phone,
   username or email once the query is 3-64 characters (`userQuery`, test-held
   to `userSearchSchema`), 300ms after typing stops, and shows name, username
   and the masked phone. Only an `active` user can be picked
   (`ownerSelectable`) — the create refuses anyone else as `owner_inactive`.
   The body still sends `ownerUserId`; tenant-service never creates a user
   (ADR-0058 (4)). Without the key the sheet takes a user id, as before.
10. **One reseller is a page, not a sheet** (F-019-k). A list row is a `Link`
    to `panelResellerPath(id)`, so the reseller can be sent to someone and
    reloaded where it was left. Sections live in tabs — `overview` (facts,
    package and period, status) and `billing` — and `?tab=` carries the open
    one, `?page=` the ledger's page; a later section of its own (F-018-h/i/j)
    is another tab here, not another sheet.
11. **The ledger is read, never assembled** (F-019-j). `ResellerLedger` pages
    `GET /api/billing/tenant-wallets/:tenantId/transactions` by 20, newest
    first, and prints the route's `balance` — never a sum of the page. It
    renders the reseller's own ledger row (`TenantBillingRow`), which shows the
    movement's `referenceId` only when this read hands it over. An adjustment
    moves the balance, so the ledger re-reads with the page's write counter.
    A failed read is the server's translated sentence and a retry, not the
    empty state (`contract.financial.md`).
