import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';

import { METER_KEYS } from './meter';
import { METERED_RATE_UNIT_BYTES } from './metered-rate';
import { rateCardAt, rateCardsInEffect, vpnTrafficRateAt, type RateCardRow } from './rate-card';

/**
 * A rate card prices a meter on a variant (F-118-d, ADR-0105 decision 3).
 *
 * The failures worth a spec:
 *
 *  - **a card for one meter read as another's.** A variant may carry cards on
 *    several meters; the card in effect is chosen per meter, per currency.
 *  - **a card the byte engine cannot honour, locked as if it could.** Until
 *    `grant_meter` (F-118-e) moves the rest, a VPN Grant holds one per-GiB
 *    rate, prepaid or postpaid (F-118-k). A newer hybrid or differently sized
 *    card is no rate for it — and must not let an older card win in its place.
 *  - **`metered_rate` rows lost on the way.** Each becomes a `vpn.traffic`
 *    prepaid card per 2^30 bytes, nothing included, then metered.
 */

const at = (iso: string) => new Date(iso);

const card = (id: string, over: Partial<RateCardRow> = {}): RateCardRow => ({
  id,
  meterKey: METER_KEYS.vpnTraffic,
  unitSize: BigInt(METERED_RATE_UNIT_BYTES),
  unitPrice: new Prisma.Decimal('0.40000000'),
  currencyCode: 'USD',
  mode: 'prepaid',
  includedQuantity: BigInt(0),
  afterIncluded: 'metered',
  effectiveFrom: at('2026-01-01T00:00:00Z'),
  isActive: true,
  ...over,
});

describe('rateCardAt', () => {
  it("picks the newest active card for the meter asked, in the tenant's currency", () => {
    const cards = [
      card('old'),
      card('new', { effectiveFrom: at('2026-06-01T00:00:00Z') }),
      card('other-meter', { meterKey: 'sms.sent', effectiveFrom: at('2026-08-01T00:00:00Z') }),
      card('rial', { currencyCode: 'IRR', effectiveFrom: at('2026-08-01T00:00:00Z') }),
      card('off', { effectiveFrom: at('2026-07-01T00:00:00Z'), isActive: false }),
      card('later', { effectiveFrom: at('2026-12-01T00:00:00Z') }),
    ];
    expect(rateCardAt(cards, at('2026-09-01T00:00:00Z'), 'USD', METER_KEYS.vpnTraffic)?.id).toBe('new');
    expect(rateCardAt(cards, at('2026-09-01T00:00:00Z'), 'IRR', METER_KEYS.vpnTraffic)?.id).toBe('rial');
    expect(rateCardAt(cards, at('2025-12-31T00:00:00Z'), 'USD', METER_KEYS.vpnTraffic)).toBeNull();
  });

  it('asks the database the same question, narrowed to one meter', () => {
    const now = at('2026-09-01T00:00:00Z');
    expect(rateCardsInEffect(now, 'IRR', METER_KEYS.vpnTraffic)).toEqual({
      isActive: true,
      effectiveFrom: { lte: now },
      currencyCode: 'IRR',
      meterKey: 'vpn.traffic',
    });
  });
});

describe('vpnTrafficRateAt — the rate a VPN Grant locks at issue (ADR-0073)', () => {
  const now = at('2026-09-01T00:00:00Z');

  it('is the prepaid per-GiB card in effect, as a metered rate with its currency', () => {
    expect(vpnTrafficRateAt([card('c1')], now, 'USD')).toEqual({
      id: 'c1',
      rate: new Prisma.Decimal('0.40000000'),
      currencyCode: 'USD',
      effectiveFrom: at('2026-01-01T00:00:00Z'),
      isActive: true,
    });
  });

  it('is a postpaid per-GiB card too (F-118-k): the same rate, held instead of debited', () => {
    expect(vpnTrafficRateAt([card('c1', { mode: 'postpaid' })], now, 'USD')?.id).toBe('c1');
  });

  it.each<[string, Partial<RateCardRow>]>([
    ['a hybrid with bytes included (F-118-e)', { includedQuantity: BigInt(50) * BigInt(METERED_RATE_UNIT_BYTES) }],
    ['stop after the included bytes', { afterIncluded: 'stop', includedQuantity: BigInt(1) }],
    ['a unit other than 2^30 bytes', { unitSize: BigInt(1_000_000_000) }],
  ])('is none when the newest card is %s — never the older card behind it', (_, over) => {
    const cards = [card('older'), card('newer', { ...over, effectiveFrom: at('2026-06-01T00:00:00Z') })];
    expect(vpnTrafficRateAt(cards, now, 'USD')).toBeNull();
  });

  it("ignores another meter's card", () => {
    expect(vpnTrafficRateAt([card('sms', { meterKey: 'sms.sent' })], now, 'USD')).toBeNull();
  });
});

describe('the migration that makes metered_rate rows vpn.traffic cards', () => {
  const MIGRATIONS = join(__dirname, '../../../../prisma/domains/migrations');
  const dir = readdirSync(MIGRATIONS).find((d) => d.endsWith('_a_rate_card_prices_a_meter'));
  const sql = dir ? readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8') : '';

  it('copies every row as a prepaid card per 2^30 bytes, nothing included, then metered', () => {
    expect(dir).toBeDefined();
    expect(sql).toMatch(/INSERT INTO "catalog"\."rate_card"[\s\S]*?FROM "catalog"\."metered_rate"/);
    expect(sql).toMatch(/'vpn\.traffic', 1073741824, m\."rate", m\."currencyCode", 'prepaid', 0, 'metered'/);
  });

  it('leaves metered_rate unwritable, so no rate lands where nothing reads it', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE ON "catalog"\."metered_rate" FROM txnet_app, txnet_cross_tenant/);
  });
});
