---
id: panel-web
layer: interface
status: active
version: 20
updated: 2026-09-19
---

# Contract — panel-web: resellers (F-018-k, F-019-k, F-019-i)

A topic file of [contract.md](contract.md) (§10). Three pages under
`(panel)/resellers/`, each a server shell over a client view:

| page | route | files |
|---|---|---|
| the list | `/resellers` (`PANEL_RESELLERS`) | `_components/ResellersView.tsx`, `CreateResellerSheet.tsx` with `OwnerPicker.tsx` |
| one reseller | `/resellers/[id]` (`panelResellerPath`) | `[id]/_components/ResellerDetailView.tsx`, `ResellerLedger.tsx` |
| buying one | `/resellers/buy` (`PANEL_RESELLER_PURCHASE`) | `buy/_components/BuyResellerView.tsx`, rules `_lib/purchase.ts` |

**The first two are the platform owner's; the third is not.** They share a
route prefix and nothing else, so **no `layout.tsx` may be added under
`(panel)/resellers/` that gates on `canAdministerResellers`** — it would lock
out exactly the visitors `/resellers/buy` exists for.

`_lib/resellers.ts` holds the rules of the owner's two, `_components/resellers-ui.tsx`
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

## Buying one (F-019-i)

`/resellers/buy`: a platform user buys a reseller of their own, paid from their
wallet. `_lib/purchase.ts` holds its rules, `resellerPurchaseApi`
(`lib/tenant-api.ts`) its three calls — `GET /api/tenants/purchase/packages`,
`GET /api/tenants/purchase/slug?name=`, `POST /api/tenants/purchase`. Every
rule behind them is [tenant/contract.admin.md](../../domains/tenant/contract.admin.md)
"A platform user buys a reseller" (F-019-h, ADR-0061).

12. **A different audience, and no permission key.** `canBuyReseller` is
    `me.tenant.type === "platform_owner"` and nothing else: the routes admit
    any signed-in user of the platform owner's tenant, so a key would hide the
    page from the people it is for. The menu entry (`buy-reseller`) names
    `tenantTypes` alone for the same reason. `not_platform_user` stays the
    boundary, and the page shows that sentence rather than a form it knows will
    be refused.
13. **Its own refusal sentences** (`PURCHASE_REFUSAL_KEYS`, namespace
    `common.resellerPurchase`), read from `PurchaseRejection`'s own source by
    the spec. Not `REFUSAL_KEYS`: the same word means something else here —
    `insufficient_balance` is the **buyer's** wallet, not a reseller's balance
    with the platform — and `already_reseller` and `buyer_inactive` have no
    sentence in that set at all. `resellers-ui`'s `useMessage` is the
    administration's, so this page has `usePurchaseMessage`.
14. **`insufficient_balance` is shown with the top-up beside it.** It is the one
    refusal the buyer can act on, and a sentence alone leaves them on a page
    they cannot finish; the link is `PANEL_DEPOSIT`.
15. **The address is a suggestion until the buyer edits it.** `name` asks
    `GET /purchase/slug` 300ms after typing stops (`suggestibleName` keeps a
    name the route would refuse off the wire — the read budget is shared with
    the package list); the first keystroke in the address field stops the
    suggestion overwriting it for good. Left empty, `purchaseBody` **omits**
    `slug` rather than sending `""`, which the `.strict()` schema refuses, and
    the purchase takes the name's own. A failed suggestion is silent: the buyer
    can type one.
16. **A choice the service takes.** Periods are `BILLING_MODELS`; a package is
    offered for a period only when priced for it (`offerChoices` — the route
    lists active packages only, so there is no `isActive` filter here), and
    changing the period drops a pick that period does not sell. The service
    reads both again under the package's lock, so this saves a round trip and
    is never the check.
17. **No figure is computed here** (rule 7 again, and it moves real money). The
    price is the offer's, the balance `billingApi.walletBalance()`, and what was
    charged is the answer's `charged` — never the price the page showed.
