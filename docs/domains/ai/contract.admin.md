---
id: ai
layer: domain
status: draft
version: 2
updated: 2026-10-02
---

# Contract — ai: the reseller's AI admin (F-038-j1)

`ai-service`'s `admin/` — the routes the reseller's AI page (F-038-j2)
calls, through Traefik's `PathPrefix(/api/ai)` behind `my-auth` and the
`ai.manage` permission (`AiManageGuard`; Admin, and SuperAdmin as `*`;
migration `20261002001000_ai_manage_permission`). Its own file: contract.md is
at its ceiling. Per-type model mode and caps are F-038-w's (user, 2026-10-02).

## Rules

1. **The tenant is the gate's, the author too.** Every route reads and writes
   only `X-Tenant-Id`; a write records `X-User-Id`. No body or query names
   either, and a body that tries is a 400 (`.strict()`), never obeyed.
2. **Reads are `read`, writes `staffWrite`** (C-11): a suspended reseller sees
   its page and changes nothing. The report is a POST and declares `read`.
3. **Switching the engine off stops what is queued.** `engineEnabled: false`
   `suppressed`s every `scheduled`/`awaiting_approval` action by
   `engine_disabled` in the same transaction; a type list goes through
   `TypeSwitch` (F-1509, `type_disabled`); an offer off, through `Offers`
   (`offer_guardrail`).
4. **A threshold is a decimal string at two places in [0, 1]; the holdout
   share an integer 5–20** — never 0 (ADR-0109 point 10). Lowering it keeps
   the recorded members (F-1508).
5. **A customer is named by id only** — ai reads no contact column
   (invariant 7); the page links to where the panel already shows the user.
6. **Margins (F-1528, `admin/margins.ts`): the plans the tenant sells** —
   active, public, priced (its own price before the platform's) — each priced
   against the package's rate **in force now**, as a sale or renewal would lock
   it: `vpn.traffic` for a bag, `vpn.unlimited.time` for an unlimited plan,
   through F-038-p's `wholesaleCost`, read via `ai.reader_package_rate`
   (`20261002001400`: the bound tenant's package only). `losingMoney`: price
   under cost. The cost is **null with `cost_unknown`** — no rate, another
   currency (C-02), a metered plan, no traffic or period stated — and flags
   nothing. `grants`: active Grants on the plan; `losing`, those whose locked
   leg costs more than the price; `costUnknown`, those with no leg. Losing
   first, then the thinnest margin, unknown last. Read on request, nothing
   stored; the alert to the tenant's staff is F-1528-b.
7. **Plan layout (F-1527, `admin/plan-layout.ts`): sizes, never a price**
   (ADR-0109 point 9). Families: the bag plans sold (active, public, prepaid,
   a traffic size) by product, mode and length. Each active Grant's use per
   period is its `vpn.traffic` readings (`ai.meter_reading` — meters only,
   point 6) over the last 30 days scaled to the plan's length; only a Grant
   whose readings reach back the whole window is measured, and one at 98 % of
   its bag is at the cap. From 10 measured users of a plan: `add_smaller` —
   ≥ 40 % use under 40 % of it, sized at their 75th percentile × 1.25 rounded
   up (5 GiB steps, 1 GiB under 5), when no plan between that and it is sold;
   `add_bigger` — ≥ 25 % of the family's largest plan at the cap, 1.5 × it,
   `demandCensored`; `no_takers` — a plan nobody holds, once the family has 10
   measured. Read on request, nothing stored.

## Routes

| route | body / query | answer |
|---|---|---|
| `GET /api/ai/admin/settings` | — | `{settings: {engineEnabled, engineRuns, confidenceThreshold, holdoutPercent, disabledActionTypes, actionTypes}}` — `engineRuns` false when the package lacks `ai_recommendation` or the tenant may not sell (F-1550, F-038-x), whatever the switch says |
| `PUT /api/ai/admin/settings` | any of `engineEnabled`, `confidenceThreshold`, `holdoutPercent`, `disabledActionTypes` | the settings, as read after |
| `GET /api/ai/admin/at-risk` | `kind=renewal\|run_out`, `cursor?`, `take` ≤ 100 (50) | `{items: [{userId, grantId, value, predictedAt, confidence, reasons}], nextCursor}` — `renewal`: `renewal_probability` under 0.5 (`AT_RISK_RENEWAL_BELOW`), Grant end ahead, soonest first; `run_out`: `meter_exhaustion` inside 7 days |
| `GET /api/ai/admin/margins` | — | `{items: [{variantId, productId, sku, nameKey, billingMode, durationDays, size, unlimited, price, cost, margin, losingMoney, reasons, grants: {active, losing, costUnknown}}]}` — rule 6 (F-1528) |
| `GET /api/ai/admin/plan-layout` | — | `{families: [{productId, billingMode, durationDays, plans: [{variantId, sku, nameKey, size, active, measured, usage: {p25, p50, p75, p90} \| null, under, atCap}], suggestions: [{code, variantId, users, measured, share?, size?, demandCensored?}]}]}` — bytes as decimal strings; rule 7 (F-1527) |
| `GET /api/ai/admin/resellers` | `kind=quota_exhaustion\|churn_risk`, `cursor?`, `take` ≤ 100 (50) | **the platform owner only** — anyone else 403 `not_platform_owner`. `{items: [{tenantId, slug, value, predictedAt, confidence, reasons}], nextCursor}`; [contract.resellers.md](contract.resellers.md) (F-038-o2) |
| `POST /api/ai/admin/reports/uplift` | `{from, to}`, ≤ 366 days | the F-038-i report ([contract.md](contract.md) "Outcomes and uplift") |
| `GET /api/ai/admin/offers` | — | `{items}` — `Offers.list` |
| `POST /api/ai/admin/offers` | the offer's fields (contract.md "offers"), no tenant, no author | `{offer}`; 400 `template_not_found` / `template_not_a_discount` / `variant_not_found` |
| `PATCH /api/ai/admin/offers/:offerId` | `name?`, `maxDiscountPercent?`, `dailyBudget?`, `currencyCode?`, `isActive?` | `{offer}`; 404 `offer_not_found` (another tenant's too) |

403 `ai.manage is required` without the permission; 401 with no gate identity.

## Proof

`admin/ai-admin.spec.ts`: the door; no body names a tenant or author;
threshold and holdout bounds; defaults and `engineRuns`; a write's tenant and
author, the type list through `TypeSwitch`; engine off stops the queue; the
at-risk filters, order and paging. `admin/margins.spec.ts`: the rate in
force, a losing plan, the order, the time meter for an unlimited plan, every
unknown cost, the Grants count. `admin/plan-layout.spec.ts`: the window and
the period scaling, the families, the cap, the minimum sample, each
suggestion and when it is withheld.
