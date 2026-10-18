import { describe, expect, it } from 'vitest';

import { createVariantSchema, updateVariantSchema } from './catalog-admin.schema';
import { MAX_SALES_CAP, salesOf } from './sales-cap';

const base = { sku: 'VPN-50', billingMode: 'prepaid', visibility: 'public', price: '5' };

describe('salesOf (F-513-a)', () => {
  it('no cap: nothing remains to count and it never sells out', () => {
    expect(salesOf({ salesCap: null, soldCount: 900, reservedCount: 40 })).toEqual({ cap: null, sold: 900, reserved: 40, remaining: null, soldOut: false });
  });

  it('a pending invoice holds a unit as a sale does', () => {
    expect(salesOf({ salesCap: 10, soldCount: 6, reservedCount: 3 })).toMatchObject({ remaining: 1, soldOut: false });
    expect(salesOf({ salesCap: 10, soldCount: 6, reservedCount: 4 })).toMatchObject({ remaining: 0, soldOut: true });
  });

  it('a cap lowered under what is sold closes sales and undoes none', () => {
    expect(salesOf({ salesCap: 5, soldCount: 8, reservedCount: 1 })).toEqual({ cap: 5, sold: 8, reserved: 1, remaining: 0, soldOut: true });
  });
});

describe('the variant schemas take a cap (F-513-a)', () => {
  it('a whole number from 1, or null to clear it', () => {
    expect(createVariantSchema.parse({ ...base, salesCap: 100 }).salesCap).toBe(100);
    expect(updateVariantSchema.parse({ salesCap: null }).salesCap).toBeNull();
    expect(updateVariantSchema.parse({}).salesCap).toBeUndefined();
  });

  it('refuses 0, a fraction and more than the ceiling', () => {
    for (const salesCap of [0, -1, 2.5, MAX_SALES_CAP + 1]) {
      expect(updateVariantSchema.safeParse({ salesCap }).success).toBe(false);
    }
  });
});
