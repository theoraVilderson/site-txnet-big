---
id: adr-0107
status: accepted
updated: 2026-10-01
---

# ADR 0107 — a reseller package sells quotas; past one it charges or stops

- **Status:** accepted, not built (series F-019-v1 … F-019-v11)
- **Date:** 2026-10-01 (user approved every point below; "plan it so the
  business does not break in the long run, and leave room for new limits —
  tickets, AI, anything")
- **Affects units:** tenant, billing, catalog, notification, panel-web
- **Builds on:** ADR-0106 (keys, three levels), ADR-0105 (wallet, never
  served unfunded). Leaves alone: F-019-t7's per-buyer purchase windows —
  those bound one user against abuse, not what a reseller's package sells

## Context

ADR-0106 gives every limit one answer past it: refuse. A reseller package
("Gold") is what a reseller buys, so its limits are what it sells — and a
reseller that outgrows one should either pay per extra unit or be stopped
until it upgrades. Which of the two is the platform owner's choice per limit
and per product. Upgrading today takes effect only at renewal, so a stopped
reseller stays stopped for the rest of its period: the upgrade button would
not unlock anything.

## Decision

1. **Two kinds of key.** Every registry key declares `kind`:
   - `quota` — units consumed in a period (campaign sends, product sales,
     later tickets, AI requests). May be sold past its included amount.
   - `guard` — a safety or capacity ceiling (bulk job size, a user's metered
     cap, staff seats, domains, end users, monthly platform traffic). Always
     refuses; never bought past. A guard may become a quota by its own
     decision, never by a setting.
2. **Past a quota: `stop` or `overage`**, set per key at the same three
   levels as the number (package, reseller, platform; most specific wins).
   `overage` carries a unit price in the platform's currency. Default `stop`.
3. **A product sales quota is a quota** keyed by (package, product): included
   per day / week / month, each optional, counted over **all** of the
   reseller's sales of that product, with its own `stop`/`overage` and price.
   A product is sellable by a reseller only if its package lists it.
4. **One engine, one call.** `shared-core` `ResellerQuota`:
   `consume(tx, {tenantId, meter, qty, sourceRef})` and
   `release(tx, sourceRef)`, under a per-(tenant, meter) advisory lock, over
   one usage table (one row per `sourceRef`, unique; included and overage
   quantities, the ledger entry it charged). A new limited thing — tickets,
   AI — is a registry entry plus one `consume` where it happens. No table,
   no new service code path.
5. **Overage is prepaid, at the moment.** Debited from `tenant_billing_wallet`
   via `TenantBillingLedger` in the same transaction as the act. No invoice
   at month end, no debt: an empty wallet behaves as `stop` and alerts.
6. **The reseller may cap its own overage spend** per subscription period;
   reaching it behaves as `stop`.
7. **Periods are fixed, not rolling**: day from 00:00, week from Saturday, in
   one platform timezone setting (default `Asia/Tehran`); month = the
   reseller's subscription period. A statement must say "1000 included, 43
   extra this week".
8. **Terms lock per subscription period.** Included amounts and prices in
   force at the period's start hold until its end; the platform's changes
   apply from the next period (or an upgrade, point 9).
9. **Upgrade now, prorated; downgrade at period end.** An upgrade charges the
   new package's price for the days left minus the old one's unused days,
   from the wallet, and its terms apply at once. A downgrade waits for the
   renewal, so a quota cannot be used high and the price paid low.
10. **Release gives back.** A sale cancelled or refunded releases its units;
    an overage unit's charge returns to the wallet (its own ledger entry).
11. **Who is told what.** The buyer refused by a `stop` hears only "not
    available now, try later" — the reseller's package is not the buyer's
    business. The reseller is alerted at 80%, at 100% (overage started, or
    stopped), and by a daily digest: units refused, overage units and cost.
12. Periods, locks and prices are exact integers / `Decimal` per C-ids in
    `CONVENTIONS.md`; every debit and give-back is a ledger row naming its
    `sourceRef`.

## Consequences

- New capabilities are limited and sold without new design: a key with
  `kind: quota`, a `consume` at the act.
- F-019-t4's `campaign_sends_daily_max` moves onto the engine (fixed day
  instead of 24 rolling hours) as the first consumer, which proves point 4.
- `PUT` package at renewal-only (tenant `contract.admin.md`) is superseded
  for upgrades by point 9.
- Rejected: month-end overage invoices (debt collection, suspension of
  debtors), rolling windows for sold quotas (unexplainable statements),
  upgrade-at-renewal (stopped resellers cannot buy their way out), overage on
  guards (protection bought with money).
