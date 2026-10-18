import { describe, expect, it } from 'vitest';

import { createVariantSchema, updateVariantSchema } from './catalog-admin.schema';
import { activeOf, availabilityOf, MAX_SALES_CAP, salesOf } from './sales-cap';

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

describe('activeOf (F-514-a)', () => {
  it('no cap: never full', () => {
    expect(activeOf({ activeCap: null, liveCount: 500, reservedCount: 3 })).toEqual({ cap: null, live: 500, held: 3, remaining: null, full: false });
  });

  it('a pending invoice holds a slot beside the live services', () => {
    expect(activeOf({ activeCap: 100, liveCount: 98, reservedCount: 1 })).toMatchObject({ remaining: 1, full: false });
    expect(activeOf({ activeCap: 100, liveCount: 98, reservedCount: 2 })).toMatchObject({ remaining: 0, full: true });
  });

  it('a cap lowered under the live count closes sales and ends none', () => {
    expect(activeOf({ activeCap: 10, liveCount: 40, reservedCount: 0 })).toMatchObject({ remaining: 0, full: true });
  });
});

describe('availabilityOf: either cap full is sold out (F-514-a)', () => {
  const counts = { salesCap: null, soldCount: 0, reservedCount: 0, activeCap: null, liveCount: 0 };

  it('the smaller of the two remainders, null with neither cap', () => {
    expect(availabilityOf(counts)).toEqual({ remaining: null, soldOut: false });
    expect(availabilityOf({ ...counts, salesCap: 1000, soldCount: 900, activeCap: 100, liveCount: 95 })).toEqual({ remaining: 5, soldOut: false });
    expect(availabilityOf({ ...counts, salesCap: 1000, soldCount: 998, activeCap: 100, liveCount: 10 })).toEqual({ remaining: 2, soldOut: false });
  });

  it('the active cap alone sells it out while lifetime sales remain', () => {
    expect(availabilityOf({ ...counts, salesCap: 1000, soldCount: 300, activeCap: 100, liveCount: 100 })).toEqual({ remaining: 0, soldOut: true });
  });
});

describe('the variant schemas take an active cap (F-514-a)', () => {
  it('a whole number from 1, or null to clear it; refuses 0 and a fraction', () => {
    expect(createVariantSchema.parse({ ...base, activeCap: 100 }).activeCap).toBe(100);
    expect(updateVariantSchema.parse({ activeCap: null }).activeCap).toBeNull();
    for (const activeCap of [0, 2.5, MAX_SALES_CAP + 1]) expect(updateVariantSchema.safeParse({ activeCap }).success).toBe(false);
  });
});
