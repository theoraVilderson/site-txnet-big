import { METER_KEYS } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { UNIT_PRICE, decimal, instant, quantity, uuid } from './catalog-admin.schema';

/**
 * A cost's first moment (F-1002-d, ADR-0151): no earlier than the 1st of the
 * current UTC month — a closed month's margin never moves, as a panel cost's
 * (F-1002-a). Absent = now.
 */
const costFrom = instant('effectiveFrom').refine(
  (v) => {
    const now = new Date();
    return new Date(v).getTime() >= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  },
  { message: 'cost_in_closed_month' },
);

/** Whose rows: absent = the caller's own; `platform` or a tenant id, the owner's alone — as `ownerOfNew` takes. */
const owner = z.union([z.literal('platform'), uuid('tenantId')]).optional();

/** What one sale of a variant costs its tenant from `effectiveFrom` on; 0 is a cost (ADR-0151 (5)). */
export const setVariantCostSchema = z.object({ amount: decimal('amount'), effectiveFrom: costFrom.optional() }).strict();

/** Never `vpn.traffic`: its cost is its panels' (ADR-0151 (3)). */
const meterKey = z
  .string()
  .min(1)
  .max(100)
  .refine((k) => k !== METER_KEYS.vpnTraffic, { message: 'meter_cost_from_panels' });

const meterCostFields = {
  meterKey,
  unitSize: quantity('unitSize').refine((v) => v !== '0', { message: 'unitSize is at least 1' }),
  unitCost: z.string({ message: 'unitCost must be a decimal string' }).regex(UNIT_PRICE, { message: 'unitCost must be a decimal string' }),
  effectiveFrom: costFrom.optional(),
};

/** What `unitSize` units of a meter cost the tenant from `effectiveFrom` on. */
export const setMeterCostSchema = z.object({ ...meterCostFields, tenantId: owner }).strict();
/** The same for the reseller the path names — the tenant is the path's. */
export const setResellerMeterCostSchema = z.object(meterCostFields).strict();
export const listMeterCostsSchema = z.object({ tenantId: owner }).strict();

/** A cost taken back from `effectiveFrom` on (F-1002-i): "not set" again, which 0 is not. */
export const unsetVariantCostSchema = z.object({ effectiveFrom: costFrom.optional() }).strict();
const unsetMeterCostFields = { meterKey, effectiveFrom: costFrom.optional() };
/** A meter's cost taken back; `tenantId` as `setMeterCostSchema`'s. */
export const unsetMeterCostSchema = z.object({ ...unsetMeterCostFields, tenantId: owner }).strict();
/** The same for the reseller the path names. */
export const unsetResellerMeterCostSchema = z.object(unsetMeterCostFields).strict();

export type SetVariantCostBody = z.infer<typeof setVariantCostSchema>;
export type SetMeterCostBody = z.infer<typeof setMeterCostSchema>;
export type SetResellerMeterCostBody = z.infer<typeof setResellerMeterCostSchema>;
export type ListMeterCostsQuery = z.infer<typeof listMeterCostsSchema>;
export type UnsetVariantCostBody = z.infer<typeof unsetVariantCostSchema>;
export type UnsetMeterCostBody = z.infer<typeof unsetMeterCostSchema>;
export type UnsetResellerMeterCostBody = z.infer<typeof unsetResellerMeterCostSchema>;
