---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-29
---

# Contract — billing / a tenant's currency change

A topic file of `contract.md` (§10). What happens to a tenant's money when its
operating currency changes (F-116-f, ADR-0098 part 5). The route and who may
call it are tenant's: `tenant/contract.currency.md`. Code:
`txnet-backend/shared-core/src/lib/billing/currency-change.ts`
(`convertOperatingCurrency`, `convertedByChanges`). Proof:
`billing-service/src/app/wallet/currency-change.int.spec.ts`.

## The change

| Rule | Why |
|---|---|
| 1. **One rate.** The caller reads the pair old -> new once (`readFxPair`, USD pivot, `currency/contract.md`); it is rounded to 18 places and stored on the `billing.currency_change` row with both legs' `currency_exchange_rate` ids. Every amount below is converted at that stored rate and rounded **once**, to the new currency's `decimalPlaces` (a metered rate to 8, a gateway rate to 18) | part 5: one snapshot. The rate stored is the rate converted at, as on a payment (F-116-e) |
| 2. **One transaction, set-based SQL, on the cross-tenant pool** (`txnet_cross_tenant_user`): every live amount of the tenant is in the old currency or all in the new one, never half | user, 2026-09-28: a job would leave wallets in both currencies and refuse credits in between |
| 3. **Safe to retry.** The tenant row is locked first and its currency re-read. Already the target: nothing written, `changeId: null`. No longer the pair's `fromCode`: `CurrencyChangeConflict`, nothing written | a retried request is harmless; a change that lost a race must not convert at a rate read for the wrong currency |
| 4. **Audited**: the `currency_change` row (who, the pair, the rate, a `summary` of what was converted) and an `admin_audit_log` row, `tenant_currency_change`, target the tenant | part 5 |

## What is converted, and what is not

| Converted (live) | How |
|---|---|
| Every wallet of the tenant's users in the old currency | a `currency_change` **debit** of the balance in the old currency (to zero), then the wallet relabelled with its balance converted and `version + 1`, then a `currency_change` **credit** of the new balance in the new currency; both rows' `referenceId` is the change. An empty wallet is relabelled and writes nothing. Each opened wallet writes `billing.wallet.changed`. Its **open** holds convert with it, each rounded **down**, and `heldAmount` becomes their sum — no ledger row, a hold is not one (F-118-a, [contract.holds.md](contract.holds.md)) |
| The price and metered rate **in effect** for each variant, and each one **scheduled** after it | a **new** row in the new currency, from now or from its own date — a price is never updated (F-0602). The old rows stay; a reader offers only rows in the tenant's currency (catalog invariant 11) |
| A Grant not closed (`pending`, `active`, `suspended`, `exhausted`) with a meter | each `grant_meter`'s `unitPrice` and `currencyCode` (F-118-l) — it debits or holds on the converted wallet. The one change `grant_meter_terms_are_locked` allows: the price moves only with its currency (user 2026-09-29) |
| A spending cap (F-118-i) | `amount` rounded to the new decimals, never below one minor unit; `spent` rounded **down**, so rounding never shrinks the owner's room ([contract.spending-cap.md](contract.spending-cap.md)) |
| Coupons (not deleted), rules, deposit presets | a fixed or gift value, a cap, purchase bounds, a fixed-amount rule, each preset. A percentage stays |
| Gateways (`tenant_gateway_config`; for the platform also `payment_gateway`) | limits, a fixed fee, fee floor/ceiling, presets. `staticRate`, `fixedAmountModifier`, `minRate`, `maxRate` are charge units per unit of the tenant's currency: **divided** by the rate, to 18 places — they are `DECIMAL(30,18)`, so an inverse pair (1 per USD -> ~0.00000095 per IRR) keeps its digits. `roundingStep` is in charge units: kept |
| An invoice still on its 30-minute clock | **cancelled**, its pending coupon holds `cancelled` and each coupon's `reservedCount` given back — it is a quote in the old currency (user, 2026-09-28) |
| For the platform only (part 4) | every reseller's `tenant_billing_wallet` (the same closing / opening pair, no `tenant.billing.credited` event — nothing was paid in), `tenant_feature_package` prices, the wholesale rates in force (`tenant_package_meter_rate`, written again in the new money from now, never rounded to nothing — summary `packageRates`, F-118-n1), unbilled `tenant_usage_meter.unitPrice`; platform-wide (`tenantId` null) prices, rates and coupons |

**Not converted — history:** ledger rows, earlier price rows, paid / expired /
cancelled / refunded invoices, payments of any status, settlement entries and
payouts, closed Grants, deleted coupons. Each keeps the currency it records.

## Money priced before the change that lands after it

| Rule | Why |
|---|---|
| 5. A **credit** whose `currencyCode` is not the wallet's is converted through the tenant's `currency_change` rows (`convertedByChanges`): newest first, from the wallet's currency back to the entry's, multiplying the rates; rounded once to the wallet's decimals. The row is written in the wallet's currency with `sourceAmount` / `sourceCurrencyCode` (both or neither, CHECK) | part 5: an in-flight payment "credits in the currency it asked in, converted at that snapshot" — and so does a refund of an invoice paid before the change |
| 6. No chain of changes leads there: `LedgerCurrencyMismatch` as before (invariant 10) | a credit in a currency the tenant never left is a bug, not a conversion |
| 6a. A positive amount never converts to nothing: one under a minor unit of the wallet's currency (1,000 IRR into a USD wallet) is credited **one minor unit** | rounded to zero it was refused, and its payment's settlement retried forever; the unit is at most a cent more than owed (2026-09-28) |
| 7. A **debit** in another currency is always refused | a debit priced in the old currency is a stale quote; the caller re-prices it |
| 8. `TenantBillingLedger` does the same against the **platform's** changes; `TenantBillingEntry.currencyCode` is optional, omitted = the platform's currency now. A billing top-up names its payment's | a reseller's top-up asked before the platform changed currency |
| 9. What a lent gateway's borrower is **owed** (`gateway_settlement_entry` minus `gateway_settlement_payout`, both history) is summed per currency and converted the same way into the tenant's currency now — `audit/contract.settlement.md` | summed as written, a tenant that changed currency was owed two currencies added together |

## Consumers

| unit | uses |
|---|---|
| tenant | `convertOperatingCurrency` from `PUT /api/tenants/:id/operating-currency` (built) |
| billing | `convertedByChanges` inside `WalletLedgerService` / `TenantBillingLedger` — every settlement, refund and follow-on credit reaches it (built) |
| audit | `convertedByChanges` in `SettlementService`'s owed sum (built) |
