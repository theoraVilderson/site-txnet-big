---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-02
---

# panel-web — the tenant's AI page (F-038-j2)

`(panel)/ai/`, menu entry `ai` behind `ai.manage`, over `lib/ai-api.ts`'s
`aiAdminApi` — ai's `/api/ai/admin/*` ([ai/contract.admin.md](../../domains/ai/contract.admin.md)).
Four tabs, each reading when opened: settings, discount offers, at risk, report.
Per-type model mode and caps are F-038-w's page (user, 2026-10-02).

## Rules

1. **No call names a tenant or an author** — ai takes both from the gate.
2. **A settings save sends only what changed** (`patchOf`): never a value
   another admin may have changed meanwhile. A threshold outside [0, 1] at two
   places, or a holdout share outside 5–20, disables the save — the server's
   bounds, held here so they are never sent.
3. **`engineRuns: false` is said out loud** (`settings.notRunning`), whatever
   the switch shows: the package lacks AI or the tenant may not sell.
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

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| ai | `/api/ai/admin/settings`, `…/at-risk`, `…/reports/uplift`, `…/offers` | the tab shows the error line; the others work |
| billing | `GET /api/billing/coupons?kind=discount` (templates, `coupon.manage`) | the form says there is no template to use |

## Proof

`ai/ai-page.test.tsx`: only the change saved; bad bounds never sent;
not running said; templates filtered and the currency taken from one; a
refusal worded; an offer off; at-risk link, worded reasons, paging; the
report's period and arms.
