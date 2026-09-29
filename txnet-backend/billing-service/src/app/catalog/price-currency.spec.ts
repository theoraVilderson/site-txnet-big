/**
 * A tenant prices in its operating currency (F-116-d, ADR-0098 part 2).
 *
 * What breaks without anyone seeing it:
 *  - **a dollar price on a rial shop.** The platform's rows are shared-read, so
 *    a reseller on `IRR` reads the platform's `USD` price. Quoted, its user
 *    pays 5 "rial" for a 5-dollar service, or the ledger refuses the debit at
 *    the last step. A price in another currency is no price for that tenant
 *    (user, 2026-09-28): the variant is simply not offered, as one with no
 *    price at all is not;
 *  - **an invoice labelled with the tenant's currency, not its price's.** The
 *    invoice copies the price it was computed from, currency and all;
 *  - **a metered block debited in a currency its rate was never in.** A Grant
 *    locks its rate's currency with the rate, and a block is priced in it.
 *
 * The rule is spelled once — the pure rule for a row in hand, the `where`
 * fragment for the database — and both are held here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FulfilmentKind, GrantSource, Prisma, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { METER_KEYS, offeredToTenant, pricesInEffect, rateCardsInEffect, runWithTenant } from '@txnet-backend/shared-core';

import { grantFromVariant } from '../entitlement/grant';
import { priceAt, rateCardAt, sellableOfferById } from './catalog-reads';

const D = (v: string) => new Prisma.Decimal(v);
const at = (iso: string) => new Date(iso);
const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = at('2026-09-28T12:00:00Z');

const row = (id: string, currencyCode: string, effectiveFrom: string) => ({
  id,
  amount: D('5.00'),
  // A `vpn.traffic` prepaid card per GiB, as a `metered_rate` row became (F-118-d).
  meterKey: METER_KEYS.vpnTraffic,
  unitSize: BigInt(1073741824),
  unitPrice: D('0.50000000'),
  mode: 'prepaid' as const,
  includedQuantity: BigInt(0),
  afterIncluded: 'metered' as const,
  currencyCode,
  effectiveFrom: at(effectiveFrom),
  isActive: true,
});

describe('a price or a rate counts only in the currency asked for', () => {
  const history = [row('usd-new', 'USD', '2026-09-01T00:00:00Z'), row('irr-old', 'IRR', '2026-08-01T00:00:00Z')];

  it('skips a newer row in another currency and answers the one in the currency asked', () => {
    expect(priceAt(history, NOW, 'IRR')?.id).toBe('irr-old');
    expect(priceAt(history, NOW, 'USD')?.id).toBe('usd-new');
    expect(rateCardAt(history, NOW, 'IRR', METER_KEYS.vpnTraffic)?.id).toBe('irr-old');
  });

  it('has no price at all when no row is in that currency', () => {
    expect(priceAt(history, NOW, 'EUR')).toBeNull();
    expect(rateCardAt(history, NOW, 'EUR', METER_KEYS.vpnTraffic)).toBeNull();
  });

  it('asks the database the same question', () => {
    expect(pricesInEffect(NOW, 'IRR')).toEqual({ isActive: true, effectiveFrom: { lte: NOW }, currencyCode: 'IRR' });
    expect(rateCardsInEffect(NOW, 'IRR', METER_KEYS.vpnTraffic)).toEqual({ isActive: true, effectiveFrom: { lte: NOW }, currencyCode: 'IRR', meterKey: 'vpn.traffic' });
    expect(offeredToTenant(TENANT, NOW, 'IRR').prices).toEqual({
      some: { isActive: true, effectiveFrom: { lte: NOW }, currencyCode: 'IRR', OR: [{ tenantId: TENANT }, { tenantId: null }] },
    });
  });
});

describe('an offer is priced in the tenant’s operating currency', () => {
  function variant(prices: ReturnType<typeof row>[]) {
    return {
      id: 'v1',
      sku: 'VPN-30',
      tenantId: null,
      nameKey: null,
      visibility: VariantVisibility.public,
      isActive: true,
      quotas: { traffic_bytes: { limit: 1024 } },
      durationDays: 30,
      billingMode: VariantBillingMode.prepaid,
      qualityTier: 'standard',
      panelGroupId: null,
      product: {
        id: 'p1',
        key: 'vpn',
        nameKey: 'catalog.product.vpn.name',
        descriptionKey: null,
        fulfilmentKind: FulfilmentKind.network_access,
        featureKeys: [],
        isActive: true,
        categories: [{ position: 0, category: { key: 'vpn', nameKey: 'catalog.category.vpn.name', isActive: true, parentId: null } }],
      },
      prices,
    };
  }

  function txFor(operatingCurrencyCode: string, prices: ReturnType<typeof row>[]) {
    const asked: unknown[] = [];
    const tx = {
      tenant: { findUnique: async () => ({ operatingCurrencyCode }) },
      productVariant: {
        findUnique: async (q: unknown) => {
          asked.push(q);
          return variant(prices);
        },
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, asked };
  }

  const sell = (tx: Prisma.TransactionClient) => runWithTenant({ id: TENANT }, () => sellableOfferById(tx, 'v1', NOW));

  it('does not offer the platform’s dollar price to a rial tenant', async () => {
    const { tx } = txFor('IRR', [row('usd', 'USD', '2026-09-01T00:00:00Z')]);
    expect(await sell(tx)).toBeNull();
  });

  it('carries the price’s currency on the offer, for the invoice to copy', async () => {
    const { tx, asked } = txFor('IRR', [row('irr', 'IRR', '2026-09-01T00:00:00Z')]);
    const offer = await sell(tx);
    expect(offer?.price).toMatchObject({ id: 'irr', amount: '5.00', currencyCode: 'IRR' });
    // The database is asked for the tenant's currency only, not handed every row.
    expect(JSON.stringify(asked[0])).toContain('"currencyCode":"IRR"');
  });
});

describe('a metered Grant locks its rate’s currency with the rate', () => {
  const metered = {
    billingMode: VariantBillingMode.metered,
    quotas: {},
    durationDays: 30,
    rateCards: [row('usd', 'USD', '2026-09-01T00:00:00Z'), row('irr', 'IRR', '2026-08-01T00:00:00Z')],
    product: { featureKeys: [] },
  };

  it('copies the rate in the tenant’s currency, and that currency', () => {
    const g = grantFromVariant({ source: GrantSource.coupon, startsAt: NOW, currencyCode: 'IRR' }, metered);
    expect(g.meteredRate?.toString()).toBe('0.5');
    expect(g.meteredRateCurrencyCode).toBe('IRR');
  });

  it('has neither with no rate in the tenant’s currency, nor on a prepaid Grant', () => {
    const none = grantFromVariant({ source: GrantSource.coupon, startsAt: NOW, currencyCode: 'EUR' }, metered);
    expect([none.meteredRate, none.meteredRateCurrencyCode]).toEqual([null, null]);
    const prepaid = grantFromVariant({ source: GrantSource.coupon, startsAt: NOW, currencyCode: 'IRR' }, { ...metered, billingMode: VariantBillingMode.prepaid });
    expect([prepaid.meteredRate, prepaid.meteredRateCurrencyCode]).toEqual([null, null]);
  });
});

describe('the columns say it, and a writer must', () => {
  const dir = join(__dirname, '../../../../prisma/domains/migrations');
  const name = readdirSync(dir).find((d) => d.endsWith('_a_price_is_in_its_tenants_currency'));
  const sql = name ? readFileSync(join(dir, name, 'migration.sql'), 'utf8') : '';

  it.each(['price', 'metered_rate'])('%s.currencyCode is backfilled USD, then required with no default', (table) => {
    expect(sql).toContain(`ALTER TABLE "catalog"."${table}"`);
    expect(sql).toContain(`"${table}_currency_code_shape"`);
    expect(sql).toMatch(new RegExp(`ALTER TABLE "catalog"\\."${table}" ALTER COLUMN "currencyCode" DROP DEFAULT`));
  });

  it('a Grant has a rate currency exactly when it has a rate', () => {
    expect(sql).toContain('"grant_metered_rate_currency_with_rate"');
    expect(sql).toMatch(/\("meteredRate" IS NULL\) = \("meteredRateCurrencyCode" IS NULL\)/);
  });
});
