/**
 * `grant_meter` (F-118-e, ADR-0105 decision 4): the rate card locked on the
 * Grant at issue, per meter — ADR-0073 for every meter.
 *
 * What breaks without anyone seeing it:
 *  - **a sold Grant repriced.** The card in effect at the sale is copied —
 *    rate, unit, mode, included, what happens past it — and a card written
 *    later is never the one locked;
 *  - **a package plan dragged onto the meter engine** (ADR-0105 decision 0).
 *    A prepaid Grant gets no `grant_meter` row, even over a `vpn.traffic` card
 *    left in its variant's history: its path never reads a card;
 *  - **a meter sold with nothing to refuse it** (decision 7). A card on a meter
 *    no engine serves yet is not sold, rather than served unfunded;
 *  - **two answers to one VPN rate.** Since F-118-l a metered VPN Grant's
 *    meter is its only rate: nothing on the Grant row prices a byte.
 *
 * What the database holds (terms locked, one row per meter) is
 * `entitlement-schema.int.spec.ts`.
 */
import { GrantSource, Prisma, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { METER_KEYS, runWithTenant, type RateCardRow } from '@txnet-backend/shared-core';

import { GrantService } from './grant';
import { grantMetersFromVariant } from './grant-meter';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const VARIANT = '66666666-6666-4666-8666-6666666666c1';
const PAYMENT = '99999999-9999-4999-8999-999999999999';
const GIB = BigInt(1073741824);
const SALE = new Date('2026-09-01T10:00:00Z');

const card = (id: string, over: Partial<RateCardRow> = {}): RateCardRow => ({
  id,
  meterKey: 'vpn.traffic',
  unitSize: GIB,
  unitPrice: new Prisma.Decimal('0.40000000'),
  currencyCode: 'USD',
  mode: 'prepaid',
  includedQuantity: BigInt(0),
  afterIncluded: 'metered',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  isActive: true,
  ...over,
});

describe('grantMetersFromVariant', () => {
  it('locks the card in effect at the sale per meter, with its counters at zero', () => {
    const later = card('later', { unitPrice: new Prisma.Decimal('0.25'), effectiveFrom: new Date('2026-10-01T00:00:00Z') });

    const out = grantMetersFromVariant({ billingMode: VariantBillingMode.metered, rateCards: [card('now'), later] }, SALE, 'USD');

    expect(out).toEqual({
      unserved: null,
      meters: [
        {
          meterKey: 'vpn.traffic',
          rateCardId: 'now',
          unitSize: GIB,
          unitPrice: new Prisma.Decimal('0.4'),
          currencyCode: 'USD',
          mode: 'prepaid',
          includedQuantity: BigInt(0),
          afterIncluded: 'metered',
          consumed: BigInt(0),
          billed: BigInt(0),
          funded: BigInt(0),
        },
      ],
    });
  });

  it('leaves a package plan off the meter engine, whatever its variant\'s card history says (decision 0)', () => {
    expect(grantMetersFromVariant({ billingMode: VariantBillingMode.prepaid, rateCards: [] }, SALE, 'USD')).toEqual({ meters: [], unserved: null });
    expect(grantMetersFromVariant({ billingMode: VariantBillingMode.prepaid, rateCards: [card('stale')] }, SALE, 'USD')).toEqual({
      meters: [],
      unserved: null,
    });
  });

  it('names a meter in effect that no engine serves yet, rather than locking it (decision 7)', () => {
    const tokens = card('ai', { meterKey: 'ai.tokens', unitSize: BigInt(1000), mode: 'postpaid' });

    expect(grantMetersFromVariant({ billingMode: VariantBillingMode.metered, rateCards: [card('now'), tokens] }, SALE, 'USD').unserved).toBe('ai.tokens');
    // A card not yet in effect, or in another currency, is not in play at all.
    const future = { ...tokens, effectiveFrom: new Date('2026-10-01T00:00:00Z') };
    expect(grantMetersFromVariant({ billingMode: VariantBillingMode.metered, rateCards: [card('now'), future] }, SALE, 'USD').unserved).toBeNull();
  });
});

describe('GrantService.issue writes the Grant\'s meters beside its quotas', () => {
  const variantRow = (billingMode: VariantBillingMode, rateCards: RateCardRow[]) => ({
    id: VARIANT,
    tenantId: null,
    isActive: true,
    visibility: VariantVisibility.public,
    billingMode,
    quotas: billingMode === VariantBillingMode.prepaid ? { traffic_bytes: { limit: 50 * 1073741824 } } : {},
    durationDays: 30,
    rateCards,
    product: { isActive: true, featureKeys: ['vpn.access'], categories: [{ position: 0, category: { key: 'vpn', isActive: true, parentId: null } }] },
  });

  function fakeTx(variant: ReturnType<typeof variantRow>) {
    const grants: Array<Record<string, unknown>> = [];
    const meters: Array<Record<string, unknown>> = [];
    const tx = {
      tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }) },
      productVariant: { findUnique: vi.fn(async () => variant) },
      grant: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `grant-${grants.length + 1}`, ...data };
          grants.push(row);
          return row;
        }),
      },
      grantMeter: {
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
          meters.push(...data);
          return { count: data.length };
        }),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, grants, meters };
  }

  const service = new GrantService({} as never);
  const issue = (tx: Prisma.TransactionClient) =>
    runWithTenant({ id: TENANT }, () =>
      service.issue(tx, { userId: USER, variantId: VARIANT, source: GrantSource.coupon, sourceReferenceId: PAYMENT, startsAt: SALE }),
    );

  it('locks a metered VPN Grant\'s card on its own row, its only rate (F-118-l)', async () => {
    const { tx, grants, meters } = fakeTx(variantRow(VariantBillingMode.metered, [card('now')]));

    await issue(tx);

    expect(meters).toEqual([
      expect.objectContaining({ tenantId: TENANT, grantId: 'grant-1', meterKey: 'vpn.traffic', rateCardId: 'now', mode: 'prepaid', consumed: BigInt(0) }),
    ]);
    expect((meters[0]['unitPrice'] as Prisma.Decimal).toString()).toBe(card('now').unitPrice.toString());
    expect(meters[0]['currencyCode']).toBe('USD');
    expect(grants[0]).not.toHaveProperty('meteredRate');
  });

  it('issues a package plan exactly as before: its bag filled, no meter row written', async () => {
    const { tx, grants, meters } = fakeTx(variantRow(VariantBillingMode.prepaid, [card('stale')]));

    await issue(tx);

    expect(grants[0]).toMatchObject({ purchasedBytes: BigInt(50) * GIB });
    expect(meters).toHaveLength(0);
  });

  it('locks a per-use card on a package plan, the door being its enforcer (F-118-h); the bag is untouched', async () => {
    const { tx, grants, meters } = fakeTx(
      variantRow(VariantBillingMode.prepaid, [card('now', { meterKey: METER_KEYS.configRegenerate, unitSize: BigInt(1), includedQuantity: BigInt(2) })]),
    );

    await issue(tx);

    expect(grants[0]).toMatchObject({ purchasedBytes: BigInt(50) * GIB });
    expect(meters).toEqual([expect.objectContaining({ meterKey: METER_KEYS.configRegenerate, includedQuantity: BigInt(2), consumed: BigInt(0), funded: BigInt(0) })]);
  });

  it('refuses a variant carrying a card on a meter nothing serves, and writes nothing', async () => {
    const { tx, grants, meters } = fakeTx(
      variantRow(VariantBillingMode.metered, [card('now'), card('ai', { meterKey: 'ai.tokens', unitSize: BigInt(1000) })]),
    );

    await expect(issue(tx)).rejects.toMatchObject({ reason: 'meter_not_served' });
    expect(grants).toHaveLength(0);
    expect(meters).toHaveLength(0);
  });
});
