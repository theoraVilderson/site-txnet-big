import { HttpException } from '@nestjs/common';

import { type RefusalStatus, refusalException } from '../request/refusal-exception';
import type { CatalogAdminRejection } from './catalog-admin.service';

/** The statuses a catalog refusal answers with. */
export type CatalogRefusalStatus = RefusalStatus;

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const CATALOG_REFUSAL_STATUS: Record<CatalogAdminRejection, CatalogRefusalStatus> = {
  not_platform_owner: 403,
  tenant_not_found: 404,
  category_not_found: 404,
  product_not_found: 404,
  variant_not_found: 404,
  panel_group_not_found: 404,
  price_not_found: 404,
  key_taken: 409,
  sku_taken: 409,
  price_in_the_past: 400,
  text_key_invalid: 400,
  texts_unavailable: 503,
  lang_unknown: 400,
  source_text_missing: 400,
  category_cycle: 409,
  category_too_deep: 400,
  capability_not_found: 404,
  capability_unknown: 400,
  capability_in_use: 409,
  group_not_found: 400,
  audience_not_allowed: 403,
  traffic_quota_required: 400,
  meter_not_found: 404,
  rate_card_not_found: 404,
  rate_card_not_served: 400,
  campaign_not_found: 404,
  campaign_overlaps: 409,
  campaign_started: 409,
  campaign_pending: 409,
  no_price_to_restore: 409,
  price_scheduled_in_campaign: 409,
  price_in_campaign: 409,
  season_not_found: 404,
  season_date_invalid: 400,
};

/** A catalog refusal as the exception its status answers with, on both doors (`CatalogAdminController`, `ResellerCatalogController`), so one client reads both. */
export function catalogRefusal(status: CatalogRefusalStatus, reason: string, message: string): HttpException {
  return refusalException(status, { reason, message });
}
