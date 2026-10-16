---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-16
---

# Contract — billing / analytics: the tabs as built after F-1001-e

A topic file of [contract.analytics.md](contract.analytics.md), opened because
that file was near its cap. The principles, the rollup, the worker and the read
routes are there and hold here unchanged; this file says what each later tab
answers and the decisions made building it. Code:
`billing-service/src/app/analytics/`.

## Customers (F-1001-f)

`GET …/analytics/customers` — the same query, door, cache and export as every
tab (`analytics-customers.ts`). It answers:

| field | what |
|---|---|
| `renewalWindowDays` | the window renewal was judged by — the tenant's, else 7 |
| `renewal` | `{rate, renewed, lapsed, pending}` over terms that **ended** in the window; also the Overview's `renewal` KPI |
| `renewalByProduct` | the same per product, most people first |
| `buyers` | `newBuyers`, `returningBuyers` per bucket |
| `signups` | `total`, `purchased7` and `purchased30` (`{count, rate}`: first purchase ever within 7 / 30 days of signing up), `series` per bucket, `bySource` |
| `topCustomers` | the 20 largest by net in the operating currency, each `{userId, name, net, orders}` — `null` to the platform's staff |

Rules, each a decision:

1. **A term is a Grant's end, not a Grant** (corrects the table's grain):
   `analytics_grant_end` is keyed by grant · `endedOn`, because a Grant an
   admin renewed in place ends more than once. A term ends when the Grant's
   `endsAt` passes (a cancelled Grant ends nothing), or when an admin moves it
   later — a `grant_renewal` (F-311-d) or a `grant_duration_change` (F-311-i)
   with a later end: that term is renewed on the day it was moved, or on its
   end when it was moved before (renewing early is renewing).
2. **A new Grant renews the term it is nearest.** Same user, same product,
   started after the ended Grant did, not cancelled; the start nearest the end
   within 30 days either side is `renewedOn`. Renewed when
   `|renewedOn − endedOn| ≤ window`; lapsed once today is past the end plus
   the window; pending until then. `panelId` is the Grant's first config's, so
   the panel filter narrows renewal as it does sales.
3. **The window re-states, never rebuilds.** `renewedOn` is kept for every
   window up to 30, so `PUT …/analytics/settings` `{renewalWindowDays}` (1..30)
   re-states every term in one `UPDATE` under the rollup's lock, bumps the
   version and writes `billing.analytics.refreshed` when a state moved. Its
   door is `settings.manage` (the split of `tenant.manage`, ADR-0144) or
   `platform.tenant.manage` — not `analytics.read`: it changes every reader's
   figures. Stored in `analytics_setting`, changed in place, not audited.
4. **A pass looks back 31 days** for both tables: a term up to 30 days old can
   still renew, a signup up to 30 days old can still buy. Older rows can no
   longer change, and a rebuild starts at the first signup or Grant too.
5. **Signups come by identity's event** (`identity.user.signed_up`, identity
   `contract.md` "Emits"), recorded by billing's metering-service as one
   `analytics_signup` row per user (a redelivery writes nothing). The users
   who existed before it were copied once by the migration, source `unknown`.
   A signup names no product: product and panel filters leave signups whole.
6. **Tier A** (ADR-0104 (3)): to the platform's staff on a reseller no person
   is listed, and a signup bucket or source, a buyers bucket or a product's
   renewal under 5 people is hidden with its complement — the whole tenant's
   count is answered, so the cells are judged as one whole. The tenant totals
   stay. A name is a label read from identity's `user`, as the lottery report
   reads one; never a figure.
