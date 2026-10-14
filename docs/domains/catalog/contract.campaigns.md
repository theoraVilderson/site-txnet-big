---
id: catalog
layer: domain
status: active
version: 9
updated: 2026-10-14
---

# Contract — catalog: campaigns, a time-boxed price

F-503's rule (D-45): a campaign **never overwrites a price**. It is two new
`price` rows written with a `price_campaign` row, and the server's clock
decides which row is in effect, as for every price. Its own file because
seasons (F-505) write their occurrences through it and
[contract.md](contract.md) is at its cap.

Code: `billing-service/src/app/catalog/price-campaign.ts` (the rules, pure),
`CatalogAdminService.createCampaign` / `listCampaigns` / `cancelCampaign`.
Proof: `price-campaign.spec.ts`. Storage: `20261002001900`, `…2000` (audit).

## Routes — on `/api/catalog` and the reseller prefix (F-066-w7), as prices

| Route | Body | Answer | Refusals |
|---|---|---|---|
| `POST /variants/:id/campaigns` | `amount`, `startsAt`, `endsAt` (after the start, else 400) | `{id, tenantId, variantId, amount, currencyCode, startsAt, endsAt, cancelledAt, priceId, restorePriceId, restoreAmount}` | `variant_not_found` 404; `price_in_the_past` 400; `campaign_overlaps`, `no_price_to_restore`, `price_scheduled_in_campaign` 409 |
| `GET /variants/:id/campaigns` | — | the variant's campaigns, newest start first, cancelled ones too | `variant_not_found` |
| `POST /campaigns/:id/cancel` | — | the campaign, `cancelledAt` set and both rows off; a second cancel answers the same | `campaign_not_found` 404, `campaign_started` 409 |

## Rules

| Rule | Why |
|---|---|
| 1. **Two rows, one transaction**: the amount from `startsAt` (`campaignEndsAt` on it), and the price in effect at `startsAt`, in the variant's currency, back from `endsAt`. Both carry `campaignId` | the price returns by itself; nothing is edited |
| 2. A plain price written before a campaign not cancelled ends is refused (`campaign_pending`) — the restore row would undo it. From its end on, or once cancelled, it is written | the admin's newer price is never silently reverted |
| 3. A plain price already scheduled inside the window refuses the campaign (`price_scheduled_in_campaign`); two campaigns on one variant may not overlap (`campaign_overlaps`; back to back is fine) | the same: one restore row would undo the other price |
| 4. Nothing in effect at the start to return to: `no_price_to_restore` | a campaign never leaves a variant at its campaign price forever |
| 5. **Cancelled only before it starts**: both rows switched off (`isActive`, the one change `price_is_history` allows). One of its rows is never switched off alone (`price_in_campaign` on `POST /prices/:id/deactivate`) | after the start, an invoice may already carry its price |
| 6. One write per variant at a time (an advisory lock on the variant) for campaigns and plain prices | the checks above read what the write meets |
| 7. **The offer counts down**: `CatalogOffer.campaignEndsAt` is the end of the campaign whose price the offer carries, while it runs; else `null` (`offerCampaignEndsAt`) | the bot and panel show the countdown from the server's clock (F-503) |
| 8. Audited: `catalog_campaign_create`, `catalog_campaign_cancel` on `price_campaign` | as every price write |

The database holds: `endsAt > startsAt`, amount ≥ 0, the variant's tenant
(`same_tenant_as_parent`), shared-read RLS as `price`, and `campaignId` /
`campaignEndsAt` fixed at insert (`price_is_history`).

## Seasons (F-505-a) — a campaign that recurs

A tenant's named windows on the **Jalali** calendar, on its own clock
(ADR-0108; a platform season on the platform owner's): `dated` — a Jalali
month and day (Nowruz 1/1, Yalda 9/30) — or `weekly` — a weekday (Thursday
4) — from `startMinute` past midnight, for `durationMinutes`. Each coming
occurrence is written as a campaign (rules above) for every variant the
season prices; never an overwrite.

Code: shared-core `catalog/seasons.ts` (`jalaliToGregorian` from the
runtime's own `ca-persian` calendar, `seasonOccurrences` — also read by the AI
engine, F-038-r), `catalog/season-plan.ts` (what is due),
`CatalogAdminService` season methods. Proof: `seasons.spec.ts`,
`season-plan.spec.ts`. Storage: `20261002002100`.

| Route (both surfaces) | Body | Answer / refusals |
|---|---|---|
| `GET /seasons` | — | the caller's seasons: fields, `prices [{variantId, amount}]`, `next {startsAt, endsAt}` (null when off) |
| `POST /seasons` | `kind: dated` + `month`, `day` / `kind: weekly` + `weekday`; `name`, `startMinute` 0–1439, `durationMinutes` 1–44640; `tenantId?` on the ambient route (`ownerOfNew`) | the season; `season_date_invalid` 400 (a day the month never has — 31 Mehr) |
| `PATCH /seasons/:id` | any field but `kind`; `isActive` | the season; `season_not_found` 404 |
| `PUT /seasons/:id/prices/:variantId` | `amount` | the season; a variant of another tenant than the season's is `variant_not_found` |
| `POST /seasons/:id/prices/:variantId/remove` | — | the season |
| `POST /api/internal/catalog/seasons/write-upcoming` | — (service token; F-505-b's job) | `{due, written, refused}` |

| Rule | Why |
|---|---|
| S1. Written **14 days ahead** (`SEASON_HORIZON_DAYS`), each occurrence that has not started — never one already running (a campaign never starts in the past) | the restore row is computed before the window opens |
| S2. **Once** per (season, variant, start): what is written is skipped, and a race loses on the partial unique `price_campaign_season_once` | safe to run twice (ADR-0027) |
| S3. Each campaign in its own transaction under the campaign's rules, authored by the season's creator; one refused (a plain price scheduled inside it, an overlap, nothing to restore) is counted and logged, never stops the rest | one variant's conflict costs no other its season |
| S4. A season prices only its own tenant's variants; switched off, it writes nothing more — written occurrences stay, cancellable as any campaign; a price changed applies to occurrences not yet written | history is never rewritten |
| S5. A day the Jalali year lacks (30 Esfand outside a leap year) has no occurrence that year | `jalaliToGregorian` answers none |

