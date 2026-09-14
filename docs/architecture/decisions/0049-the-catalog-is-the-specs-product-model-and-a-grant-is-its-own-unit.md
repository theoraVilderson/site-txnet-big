---
id: adr-0049
status: accepted
updated: 2026-09-14
---

# ADR 0049 — The catalog is the spec's product model, and a Grant is its own unit

- **Status:** accepted 2026-09-14 (rows F-026-a..f)
- **Date:** 2026-09-14
- **Affects units:** catalog, entitlement (new), network, billing, panel-web

## Context

F-026 ("product catalog") had no spec ref and was flagged `needs-decision`.
F-502-l (`free_grant` coupon) waits on it. Three things were found:

- `catalog.prisma` (`product_category` → `service_plan` →
  `service_plan_promotion`) predates the catalog. The spec (§4.2, F-501,
  F-0601/2) is `ProductCategory → Product → ProductVariant → Price`: price on
  the variant, USD only, a new `Price` row on every change, three-state
  visibility, a `fulfilmentKind` per product (§4.1).
- **Grant** (§4.4–4.6) — the one answer to "may this user use X" — has no
  table, no unit and no feature id. Its spec is prose, reachable only through
  the new `tools/spec.py --section`.
- No service implements either. Nothing built reads the old tables:
  `billing.coupon_service_scope` names a plan or a category, and
  `network.config` (unbuilt) names a plan.

## Decision (D-34, the user's calls, all as recommended except decision 5)

1. **Replace the old catalog schema with the spec's.** `service_plan` and
   `service_plan_promotion` are dropped; campaigns and time-boxed pricing come
   back with F-503/F-505. Money is `Decimal(18,2)` USD (ADR-0019, C-02), not the
   spec's `priceMicro`. `tenantId IS NULL` = a platform item, as for coupons.
2. **Grant lives in a new unit, `entitlement`** (Postgres schema
   `entitlement`): `grant` and `quota_adjustment`. The catalog says what is for
   sale; entitlement says what a user holds. Quota sits on the Grant (§4.6), so
   `network.config` points at a Grant, not a plan.
3. **Both run as modules inside `billing-service`**, like wallet and coupons
   (D-2). Separate units and Prisma schemas in one process, so a `free_grant`
   coupon issues its Grant in the same transaction. Extractable later.
4. **Scope before F-502-l: catalog + Grant core.** Schema, catalog reads and
   management, Grant issue / transition / check. No purchase flow, no
   provisioning (F-027).
5. **The panel catalog page ships in this series** (the user's call, against
   "API now, page later").

## Consequences

- `billing.coupon_service_scope` names a product or a variant instead of a
  plan or a category (F-026-a). The coupons panel's service-scope box follows.
- `resellerPath` on a Grant stays null until reseller nodes exist (F-901).
- A product's name is an i18n key (§4.3); a reseller's own wording is a later
  override, not a column.

## Alternatives considered

- **Keep `service_plan` and add price history** — no variant, so F-506's
  `admin_only` variant and §4.2's SKU have nowhere to live.
- **Grant inside `catalog`** or **`network`** — mixes what is sold with what is
  held, or ties entitlement to the VPN product the spec says the core does not
  know about (§4.1).
- **A new `catalog-service`** — a deploy target, and F-502-l would need a
  cross-service call plus the outbox to issue a Grant atomically.
