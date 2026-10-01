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
 *    both sell `VPN-30`; the caller's own row wins;
 *  - **a metered offer with no rate on it** (F-118-ae). The shop showed 0.00
 *    and "metered" for a 10 USD/GB variant: an offer carries the card in
 *    effect for each meter, the one its sale will lock — never an older one,
 *    never one in another currency;
 *  - **a reseller selling what its package does not** (F-019-v5). A platform
 *    product is offered to a reseller only if its package lists it — in the
 *    shop and at the invoice; its own products are never narrowed.
 *
 * Which rows a tenant can read at all is RLS: `catalog-schema.int.spec.ts`.
 */
import { FulfilmentKind, Prisma, TenantType, VariantBillingMode, VariantVisibility } from '@prisma/client';

import { CATEGORY_MAX_DEPTH, categoryLive, firstLiveCategory, liveCategoryWhere, productCategoriesLive, runWithTenant } from '@txnet-backend/shared-core';

import { isListed, isSellableBySku, listOffersIn, offerRateCards, pickBySku, priceAt, sellableOfferById, type PriceRow, type RateCardRow } from './catalog-reads';

const d = (v: string) => new Prisma.Decimal(v);
const at = (iso: string) => new Date(iso);

function price(id: string, amount: string, effectiveFrom: string, isActive = true): PriceRow {
  return { id, amount: d(amount), currencyCode: 'USD', effectiveFrom: at(effectiveFrom), isActive };
}

describe('priceAt', () => {
  const history = [
    price('p1', '5.00', '2026-01-01T00:00:00Z'),
    price('p2', '6.00', '2026-06-01T00:00:00Z'),
    price('p3', '7.00', '2026-09-01T00:00:00Z'),
  ];

  it('answers the row in effect at the instant, not the newest', () => {
    expect(priceAt(history, at('2026-07-15T12:00:00Z'), 'USD')?.id).toBe('p2');
    expect(priceAt(history, at('2026-10-01T00:00:00Z'), 'USD')?.id).toBe('p3');
  });

  it('takes a row from the very instant it becomes effective', () => {
    expect(priceAt(history, at('2026-06-01T00:00:00Z'), 'USD')?.id).toBe('p2');
    expect(priceAt(history, at('2026-05-31T23:59:59.999Z'), 'USD')?.id).toBe('p1');
  });

  it('never lets a row written later reach back to an earlier instant', () => {
    const later = [...history, price('p4', '1.00', '2026-12-01T00:00:00Z')];
    expect(priceAt(later, at('2026-07-15T12:00:00Z'), 'USD')?.id).toBe('p2');
  });

  it('skips a switched-off row and falls back to the one before it', () => {
    const off = [history[0], price('p2', '6.00', '2026-06-01T00:00:00Z', false), history[2]];
    expect(priceAt(off, at('2026-07-15T12:00:00Z'), 'USD')?.id).toBe('p1');
  });

  it('has no price before the first row, or with none active', () => {
    expect(priceAt(history, at('2025-12-31T23:59:59Z'), 'USD')).toBeNull();
    expect(priceAt([price('p1', '5.00', '2026-01-01T00:00:00Z', false)], at('2026-02-01T00:00:00Z'), 'USD')).toBeNull();
    expect(priceAt([], at('2026-02-01T00:00:00Z'), 'USD')).toBeNull();
  });

  it('does not depend on the order the rows arrive in', () => {
    expect(priceAt([...history].reverse(), at('2026-07-15T12:00:00Z'), 'USD')?.id).toBe('p2');
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

describe('a category is live when it and every one above it are on (F-026-r)', () => {
  const top = { key: 'vpn', isActive: true, parentId: null, parent: null };
  const under = (parent: typeof top, isActive = true, key = 'x') => ({ key, isActive, parentId: 'p', parent });

  it('hides a whole subtree under a switched-off parent', () => {
    expect(categoryLive(under(under(top)))).toBe(true);
    expect(categoryLive(under(under({ ...top, isActive: false })))).toBe(false);
  });

  it('treats a chain deeper than the cap reads as not live — out of sight is out of sale', () => {
    let c = top;
    for (let i = 1; i < CATEGORY_MAX_DEPTH; i++) c = under(c);
    expect(categoryLive(c)).toBe(true);
    expect(categoryLive(under(c))).toBe(false);
  });

  it('keeps a product on sale while one of its categories is live, and shows it under the first live one', () => {
    const off = { ...top, key: 'off', isActive: false };
    const links = [{ position: 0, category: off }, { position: 1, category: under(top, true, 'fast') }];
    expect(productCategoriesLive(links)).toBe(true);
    expect(firstLiveCategory(links)?.key).toBe('fast');
    expect(productCategoriesLive([{ category: off }])).toBe(false);
  });

  it('asks the database the same question, to the same depth', () => {
    let where = liveCategoryWhere() as Record<string, unknown>;
    let levels = 1;
    while (Array.isArray(where['OR'])) {
      levels++;
      where = (where['OR'] as Record<string, unknown>[])[1]['parent'] as Record<string, unknown>;
    }
    expect(levels).toBe(CATEGORY_MAX_DEPTH);
    expect(where).toEqual({ isActive: true, parentId: null });
  });
});

describe('the rate an offer names (F-118-ae)', () => {
  const card = (id: string, meterKey: string, unitPrice: string, effectiveFrom: string, over: Partial<RateCardRow> = {}): RateCardRow => ({
    id,
    meterKey,
    unitSize: BigInt(1073741824),
    unitPrice: d(unitPrice),
    currencyCode: 'USD',
    mode: 'prepaid',
    includedQuantity: BigInt(0),
    afterIncluded: 'metered',
    effectiveFrom: at(effectiveFrom),
    isActive: true,
    ...over,
  });
  const now = at('2026-09-30T06:00:00Z');

  it('names the card in effect for each meter, as strings, the one the sale locks', () => {
    const cards = [
      card('old', 'vpn.traffic', '8', '2026-09-01T00:00:00Z'),
      card('new', 'vpn.traffic', '10', '2026-09-29T00:00:00Z'),
      card('regen', 'vpn.config.regenerate', '0.5', '2026-09-01T00:00:00Z', { unitSize: BigInt(1), mode: 'postpaid', includedQuantity: BigInt(2) }),
    ];
    expect(offerRateCards(cards, now, 'USD')).toEqual([
      { meterKey: 'vpn.config.regenerate', unitSize: '1', unitPrice: '0.5', currencyCode: 'USD', mode: 'postpaid', includedQuantity: '2', afterIncluded: 'metered' },
      { meterKey: 'vpn.traffic', unitSize: '1073741824', unitPrice: '10', currencyCode: 'USD', mode: 'prepaid', includedQuantity: '0', afterIncluded: 'metered' },
    ]);
  });

  it('never names a card not yet in effect, switched off, or in another currency', () => {
    const cards = [
      card('future', 'vpn.traffic', '12', '2026-10-01T00:00:00Z'),
      card('off', 'vpn.traffic', '9', '2026-09-02T00:00:00Z', { isActive: false }),
      card('eur', 'vpn.traffic', '7', '2026-09-03T00:00:00Z', { currencyCode: 'EUR' }),
      card('live', 'vpn.traffic', '8', '2026-09-01T00:00:00Z'),
    ];
    expect(offerRateCards(cards, now, 'USD').map((c) => c.unitPrice)).toEqual(['8']);
    expect(offerRateCards([], now, 'USD')).toEqual([]);
  });
});

describe("a reseller sells the platform's products its package lists (F-019-v5)", () => {
  const RESELLER = '22222222-2222-4222-8222-222222222222';
  const now = at('2026-10-01T12:00:00Z');

  const variant = (id: string, productId: string, tenantId: string | null) => ({
    id,
    sku: id,
    tenantId,
    nameKey: null,
    visibility: VariantVisibility.public,
    isActive: true,
    quotas: {},
    durationDays: 30,
    billingMode: VariantBillingMode.prepaid,
    qualityTier: 'standard',
    panelGroupId: null,
    product: {
      id: productId,
      tenantId,
      key: productId,
      nameKey: `catalog.product.${productId}.name`,
      descriptionKey: null,
      fulfilmentKind: FulfilmentKind.network_access,
      featureKeys: [],
      isActive: true,
      categories: [{ position: 0, category: { key: 'vpn', nameKey: 'catalog.category.vpn.name', isActive: true, parentId: null } }],
    },
    prices: [price(`${id}-price`, '5.00', '2026-09-01T00:00:00Z')],
    rateCards: [],
  });

  const rows = [variant('listed', 'p-listed', null), variant('unlisted', 'p-unlisted', null), variant('own', 'p-own', RESELLER)];

  function txFor(tenantType: TenantType, listed: string[]) {
    const tx = {
      tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD', tenantType }) },
      tenantSubscription: { findUnique: async () => ({ packageId: 'pkg' }) },
      packageProduct: { findMany: async () => listed.map((productId) => ({ productId })) },
      productVariant: {
        findMany: async () => rows,
        findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      },
    };
    return tx as unknown as Prisma.TransactionClient;
  }
  const inReseller = <R>(fn: () => Promise<R>) => runWithTenant({ id: RESELLER }, fn);

  it('lists the listed platform product and its own, never an unlisted platform one', async () => {
    const offers = await inReseller(() => listOffersIn(txFor(TenantType.reseller, ['p-listed']), now));
    expect(offers.map((o) => o.variantId)).toEqual(['listed', 'own']);
  });

  it('refuses the invoice for an unlisted platform product, as one not for sale', async () => {
    const tx = txFor(TenantType.reseller, ['p-listed']);
    expect(await inReseller(() => sellableOfferById(tx, 'unlisted', now))).toBeNull();
    expect((await inReseller(() => sellableOfferById(tx, 'listed', now)))?.variantId).toBe('listed');
    expect((await inReseller(() => sellableOfferById(tx, 'own', now)))?.variantId).toBe('own');
  });

  it("narrows nothing for the platform's own tenant", async () => {
    const offers = await inReseller(() => listOffersIn(txFor(TenantType.platform_owner, []), now));
    expect(offers).toHaveLength(3);
  });
});
