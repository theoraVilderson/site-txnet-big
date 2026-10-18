---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-18
---

# panel-web — the tenant's AI page (F-038-j2)

`(panel)/ai/`, menu entry `ai` behind `ai.manage`, over `lib/ai-api.ts`'s
`aiAdminApi` — ai's `/api/ai/admin/*` ([ai/contract.admin.md](../../domains/ai/contract.admin.md)).
Six tabs, each reading when opened: settings, discount offers, at risk,
margins (F-1528), plan layout (F-1527), report.
Per-type model mode and caps were F-038-w's page, dropped 2026-10-03.

## Rules

1. **No call names a tenant or an author** — ai takes both from the gate.
2. **A settings save sends only what changed** (`patchOf`, `ai-settings.ts`),
   through the kit's `SaveBar`: never a value another admin may have changed
   meanwhile. A threshold outside [0, 1] at two places, or a holdout share
   outside 5–20, disables the save — the server's bounds, held here so they
   are never sent.
3. **`engineRuns: false` is said out loud** (`settings.notRunning`), whatever
   the switch shows: the package lacks AI or the tenant may not sell.
3a. **Settings in plain words (F-038-j4).** The threshold is three levels
   (`THRESHOLD_LEVELS`: careful 0.70, balanced 0.60 = ai's default, more
   0.50); a value no level names is said as custom with no level chosen, and
   the number itself is under "advanced". Each type has a one-line
   `typeHelp` and a state from ai's activity (F-038-j3) — off, not available,
   needs a discount offer (a button opens the offers tab), silenced or partly
   held by the chosen level (judged on the confidences ai recorded, never on
   restated engine rules), sent N times, or idle. The level's line names the
   switched-on types it silences before saving. The holdout is said as "N in
   every 100". Activity unreadable: everything still saves, nothing about
   activity is claimed.
4. **Offers are made on a coupon template**: the tenant's own `percentage` or
   `fixed_amount` coupon, not deleted (`templateChoices`) — never a platform
   coupon or a gift code. The budget is in the template's currency. An offer
   is switched off, never deleted.
5. **A refusal is worded by its `error.reason`** (`common.ai.refused.*`,
   F-038-j0); anything else is the generic line.
6. **At risk: a customer is an id, linked to `myResellerUserPath`**; reasons
   are worded from an exhaustive key set (`common.ai.reasons.*`), and a code
   with no words is left out, never shown raw. Paged by `nextCursor`.
7. **The report is the last 30 days**, per type: converted of units in each
   arm, the rate difference, extra revenue per currency — never summed across
   two (C-02).
8. **Margins: a losing plan is flagged and counted at the top**, losing first
   as ai orders them; a plan named from the catalog texts, its sku otherwise.
   An unknown cost is said in words with its reason (`common.ai.margins.why.*`),
   never shown as a number; the active Grants losing at their locked rate are
   said beside it (F-1528).
9. **Plan layout: sizes, never a price** (F-1527). Per family, each plan's
   active and measured users and its median, 75th and 90th percentile use
   per period (`formatBytes`); each suggestion worded from its code
   (`common.ai.layout.addSmaller` / `addBigger` / `noTakers`), the bigger
   plan always with the note that demand past a cap is not measured.
10. **Resellers: the platform owner only** (F-038-o3) — the tab is not shown
    to any other tenant, whom ai refuses `not_platform_owner`. Each reseller
    by slug, linked to `panelResellerPath` (one deleted since the run by id,
    unlinked); run-out as a date, "full now" at 0 days; churn as a percent with
    the renewal date. A quota named as the limits page names it, a product's
    sales generically; reasons from an exhaustive set, `churn_base` and any
    unworded code left out (`ResellersAtRisk.tsx`). A third list, billing
    wallets (F-1525-b): the run-out date and the top-up as money with its
    currency, never summed across two (C-02).
11. **Usage forecast: a forecast, said as one** (F-1525-b,
    `UsageForecastView.tsx`). Per meter, named from the catalog texts
    (`meterName`), never summed across two: the next 30 days, the last 7 and
    a day's mean — bytes for `vpn.traffic` (`formatBytes`), a count otherwise.
    "Not measured yet" when ai has no readings. The billing wallet's run-out
    and the top-up that holds 30 days, or that it already does. The platform
    owner also sees every tenant summed, with how many of how many tenants
    that covers.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| ai | `/api/ai/admin/settings`, `…/settings/activity`, `…/at-risk`, `…/margins`, `…/plan-layout`, `…/reports/uplift`, `…/offers`, `…/usage-forecast`, `…/resellers` and `…/capacity` (platform owner) | the tab shows the error line; the others work |
| billing | `GET /api/billing/coupons?kind=discount` (templates, `coupon.manage`) | the form says there is no template to use |
| catalog | `GET /api/i18n/:lang/catalog` (plan names, as the shop reads them) | a plan is named by its sku |

## Proof

`ai/ai-settings.test.tsx`: only the change saved; bad bounds never sent;
not running said; each type's state; the offer button; what a level
silences, said before saving; a custom value; no activity, still saved.
`ai/ai-page.test.tsx`: templates filtered and the currency taken from one; a
refusal worded; an offer off; at-risk link, worded reasons, paging; the
report's period and arms; a losing plan flagged and counted, an unknown cost
worded; the resellers tab hidden from a reseller, a reseller linked, its
windows worded, churn as a percent, a deleted one unlinked, a wallet's
run-out and top-up; the usage tab's meters by name, not-measured said, the
wallet block only with a wallet, capacity for the platform owner alone.
