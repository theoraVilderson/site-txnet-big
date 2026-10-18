/**
 * A variant edit as the row's update: only the fields the patch names, so an
 * absent field leaves the column and `null` clears it. The SKU and billing
 * mode are never here — a link names the SKU, and a Grant copied the mode.
 */
import { Prisma } from '@prisma/client';

import type { UpdateVariantInput } from './catalog-admin.service';

/** The columns a patch writes as given; `quotas` is JSON and cast on its own. */
const PLAIN_FIELDS = ['nameKey', 'durationDays', 'visibility', 'panelGroupId', 'qualityTier', 'salesCap', 'activeCap', 'isActive'] as const;

/** `patch` as `productVariant.update`'s data. */
export function variantPatchData(patch: UpdateVariantInput): Prisma.ProductVariantUpdateInput {
  const data: Prisma.ProductVariantUpdateInput = Object.fromEntries(PLAIN_FIELDS.filter((f) => patch[f] !== undefined).map((f) => [f, patch[f]]));
  if (patch.quotas !== undefined) data.quotas = patch.quotas as Prisma.InputJsonValue;
  return data;
}
