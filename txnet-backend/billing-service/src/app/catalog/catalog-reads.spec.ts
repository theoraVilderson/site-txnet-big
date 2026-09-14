/**
 * What the catalog offers, and at what price (F-026-c, F-0602).
 *
 * What breaks without anyone seeing it:
 *  - **yesterday's invoice at today's price.** The price of a variant at an
 *    instant is the newest active row whose `effectiveFrom` is at or before it;
 *    a row written later never reaches back, and a switched-off row is skipped;
 *  - **an `admin_only` variant on sale.** `public` is listed; `unlisted` is
 *    sold only by its SKU; `admin_only` is never sold, only assigned (F-506);
 *    anything under an inactive product or category is not offered at all;
 *  - **the platform's SKU shadowing a tenant's.** A tenant and the platform may
 *    both sell `VPN-30`; the caller's own row wins.
 *
 * Which rows a tenant can read at all is RLS: `catalog-schema.int.spec.ts`.
 */
import { Prisma, VariantVisibility } from '@prisma/client';

import { isListed, isSellableBySku, pickBySku, priceAt, type PriceRow } from './catalog-reads';

const d = (v: string) => new Prisma.Decimal(v);
const at = (iso: string) => new Date(iso);

function price(id: string, amount: string, effectiveFrom: string, isActive = true): PriceRow {
  return { id, amount: d(amount), effectiveFrom: at(effectiveFrom), isActive };
}

describe('priceAt', () => {
  const history = [
    price('p1', '5.00', '2026-01-01T00:00:00Z'),
    price('p2', '6.00', '2026-06-01T00:00:00Z'),
    price('p3', '7.00', '2026-09-01T00:00:00Z'),
  ];

  it('answers the row in effect at the instant, not the newest', () => {
    expect(priceAt(history, at('2026-07-15T12:00:00Z'))?.id).toBe('p2');
    expect(priceAt(history, at('2026-10-01T00:00:00Z'))?.id).toBe('p3');
  });

  it('takes a row from the very instant it becomes effective', () => {
    expect(priceAt(history, at('2026-06-01T00:00:00Z'))?.id).toBe('p2');
    expect(priceAt(history, at('2026-05-31T23:59:59.999Z'))?.id).toBe('p1');
  });

  it('never lets a row written later reach back to an earlier instant', () => {
    const later = [...history, price('p4', '1.00', '2026-12-01T00:00:00Z')];
    expect(priceAt(later, at('2026-07-15T12:00:00Z'))?.id).toBe('p2');
  });

  it('skips a switched-off row and falls back to the one before it', () => {
    const off = [history[0], price('p2', '6.00', '2026-06-01T00:00:00Z', false), history[2]];
    expect(priceAt(off, at('2026-07-15T12:00:00Z'))?.id).toBe('p1');
  });

  it('has no price before the first row, or with none active', () => {
    expect(priceAt(history, at('2025-12-31T23:59:59Z'))).toBeNull();
    expect(priceAt([price('p1', '5.00', '2026-01-01T00:00:00Z', false)], at('2026-02-01T00:00:00Z'))).toBeNull();
    expect(priceAt([], at('2026-02-01T00:00:00Z'))).toBeNull();
  });

  it('does not depend on the order the rows arrive in', () => {
    expect(priceAt([...history].reverse(), at('2026-07-15T12:00:00Z'))?.id).toBe('p2');
  });
});

describe('what is offered', () => {
  const live = { isActive: true, productActive: true, categoryActive: true };

  it.each([
    [VariantVisibility.public, true, true],
    [VariantVisibility.unlisted, false, true],
    [VariantVisibility.admin_only, false, false],
  ])('%s: listed %s, sold by SKU %s', (visibility, listed, bySku) => {
    expect(isListed({ ...live, visibility })).toBe(listed);
    expect(isSellableBySku({ ...live, visibility })).toBe(bySku);
  });

  it.each([
    ['the variant', { isActive: false }],
    ['its product', { productActive: false }],
    ['its category', { categoryActive: false }],
  ])('offers nothing when %s is switched off', (_label, off) => {
    const v = { ...live, ...off, visibility: VariantVisibility.public };
    expect(isListed(v)).toBe(false);
    expect(isSellableBySku(v)).toBe(false);
  });
});

describe('pickBySku', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const platform = { id: 'platform', tenantId: null };
  const own = { id: 'own', tenantId: TENANT };

  it("takes the caller's own row over the platform's", () => {
    expect(pickBySku([platform, own], TENANT)?.id).toBe('own');
    expect(pickBySku([own, platform], TENANT)?.id).toBe('own');
  });

  it("falls back to the platform's, and to nothing", () => {
    expect(pickBySku([platform], TENANT)?.id).toBe('platform');
    expect(pickBySku([], TENANT)).toBeNull();
  });

  it("never answers another tenant's row, even if a caller passed one in", () => {
    expect(pickBySku([{ id: 'other', tenantId: '22222222-2222-4222-8222-222222222222' }], TENANT)).toBeNull();
  });
});
