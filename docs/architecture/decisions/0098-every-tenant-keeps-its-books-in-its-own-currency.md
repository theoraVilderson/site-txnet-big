---
id: adr-0098
status: active
updated: 2026-09-28
---

# ADR 0098 — every tenant keeps its books in its own currency

- **Status:** accepted
- **Date:** 2026-09-28
- **Affects units:** currency, tenant, billing, catalog, entitlement, engagement, panel-web, bot-app
- **Supersedes:** [ADR-0019](0019-base-currency-is-usd-with-two-decimals.md)
- **Amends:** [ADR-0002](0002-money-base-currency-and-ledger.md) (one base currency, no currency column), catalog F-0601 (products priced only in USD)
- **Decision rows:** the `F-116` series; the user approved them on 2026-09-28 (D-50, D-51)

## Context

ADR-0019 put every money column in USD and made rial a display-time
conversion. A reseller that sells in rial cannot live with that: a service it
priced at 500,000 Toman reads 550,000 the day the dollar moves 10%, and its
users' wallet balances move with it. The user asked (2026-09-28) that each
tenant work in the currency it chooses — rial, dollar, euro, and so on — and
that the platform do the same for itself. Asked with that example, the user
chose a real currency for each tenant's books, not a display layer, and chose
that a tenant may change it at any time, with its money converted.

## Decision

1. **Every tenant has an operating currency**, `Tenant.operatingCurrencyCode`,
   including the `platform_owner` row: that row's currency is the platform's.
   Existing tenants start at `USD`, so no stored amount changes meaning.
2. **A tenant's own money is in its operating currency**: its users' wallets
   and ledger, its prices and metered rates, coupons, discount rules, deposit
   presets, invoices, payments, gateway settlement and its gateway configs.
   Nothing converts on the way in or out of these tables.
3. **Every money row records its currency code** (amends ADR-0002). Because the
   operating currency can change, a row's currency cannot be derived from its
   tenant. The ledger refuses a row whose currency is not its wallet's.
4. **Money between a tenant and the platform is in the platform's currency**:
   `TenantBillingWallet`, `TenantFeaturePackage`, `TenantUsageMeter`, and a
   platform user buying a reseller (ADR-0061). An amount computed from a
   tenant's rows and charged there records the rate snapshot it crossed at.
5. **Changing the operating currency converts what is live and leaves history
   alone** (user, 2026-09-28). One rate snapshot is taken. Every wallet gets a
   closing and an opening ledger row, and every active price gets a new
   `Price` row (F-0602 still holds). Any other live amount that would
   otherwise be wrong in the new currency is converted too: fixed-amount
   coupons and rules, deposit presets, gateway min/max, spin-wheel budgets. A
   payment still in flight credits in the currency it asked in, converted at
   that snapshot. History — ledger rows, invoices, finished payments, earlier
   prices — keeps the currency it was written in. The change is audited.
6. **USD stays the pivot for rates.** A `currency_exchange_rate` row is still
   USD→code, and a pair A→B is `rate(B) / rate(A)` at one snapshot each.
   `decimalPlaces` stays ≤ 2 for any currency a tenant may choose, because
   money columns are `DECIMAL(18,2)`.
7. **Display currency stays a layer on top.** A user may still see an
   approximation in another currency (≈, F-0613); that is never charged.
8. **Every currency has its own source list, Iranian and foreign** (user,
   2026-09-28, D-51). The FX worker runs the same loop per currency: at least
   `minSources`, the median, the deviation gate. IRR keeps its domestic
   USDT/IRT books. Any other currency reads foreign order books (USDT/EUR,
   USDT/TRY on international exchanges) and, where an Iranian market quotes it
   in toman, that quote divided by the same tick's USDT/IRT. The domestic path
   keeps a rate alive through a shutdown of the international internet. A
   currency may be chosen as an operating currency only while it has a rate.
9. **A manual rate may be pinned by the platform and by a tenant** (D-51),
   with a reason and an expiry, audited (F-0608-a). A platform rate applies
   everywhere. A tenant's rate applies only inside its own books: its users'
   gateway prices, its display, its own currency change. **It never prices the
   tenant ↔ platform boundary (part 4)**; there the platform's rate, live or
   pinned, is used, so a tenant cannot pick the rate it pays the platform at.

## Consequences

- Positive: a reseller's prices and balances stay fixed in the currency it
  sells in. A new tenant in another country is a setting, not a code change.
- Negative / accepted cost: platform-wide reports that sum across tenants
  must convert, and a cross-tenant total is an approximation with a
  timestamp.
- Negative / accepted cost: the tenant ↔ platform boundary carries FX risk.
  The rate is recorded; the difference is not absorbed silently.
- Negative / accepted cost: a currency change touches every wallet of the
  tenant in one operation. It needs its own row (F-116-f), its own tests, and
  a guard against running twice.
- Negative / accepted cost: foreign sources are only reachable from a node
  with international internet, and domestic ones only from inside Iran (the
  open node question in `currency/open-questions.md`). Each currency survives
  losing one side; losing both falls to the staleness ladder (F-0607-a).
- Forecloses: summing amounts across tenants without a rate; a money column
  whose currency is implied.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Display only; the books stay USD (ADR-0019) | a rial price floats with the dollar, so a reseller cannot actually sell in rial; moving to real currencies later rewrites every price and wallet recorded by then |
| Currency locked after the first transaction | simpler and safer, but the user wants a tenant able to switch; kept as the guard while F-116-f is unbuilt |
| One paid API for every currency (Open Exchange Rates, Fixer) | one source cannot satisfy `minSources` (F-0604), and losing or being sanctioned by it leaves every non-toman tenant without a rate at once |
| A multi-currency wallet (one balance per currency) | a user of one tenant never holds two currencies. It multiplies every balance check for a case nobody asked for |

## Revisit trigger

A tenant needs to sell in two currencies at once, or a currency with three
decimals (KWD, BHD) is requested.
