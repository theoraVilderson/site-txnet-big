---
id: catalog
layer: domain
status: draft
version: 9
updated: 2026-10-02
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
