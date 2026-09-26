import { FulfilmentKind, VariantBillingMode } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { updateVariantSchema } from './catalog-admin.schema';
import { mustStateTraffic, sellsTrafficToday, trafficQuotaOf } from './traffic-quota';

const GIB = 1024 ** 3;
const traffic = (limit: number) => ({ traffic_bytes: { limit, resetPolicy: 'none' } });
const network = (quotas: unknown, billingMode: VariantBillingMode = VariantBillingMode.prepaid) => ({
  fulfilmentKind: FulfilmentKind.network_access,
  billingMode,
  quotas,
});

describe('trafficQuotaOf — what a variant says about traffic (F-111-p)', () => {
  it.each([
    ['no quotas at all', null, { kind: 'missing' }],
    ['a quota map with no traffic row (VI_PI_AN_PRV-30D)', {}, { kind: 'missing' }],
    ['another metric only', { devices: { limit: 3, resetPolicy: 'none' } }, { kind: 'missing' }],
    ['a traffic row with no usable limit', { traffic_bytes: { limit: 'lots' } }, { kind: 'missing' }],
    ['0, which the user decided means unlimited', traffic(0), { kind: 'unlimited' }],
    ['a byte limit', traffic(50 * GIB), { kind: 'limited', bytes: BigInt(50 * GIB) }],
  ])('reads %s', (_what, quotas, expected) => {
    expect(trafficQuotaOf(quotas)).toEqual(expected);
  });
});

describe('mustStateTraffic — whose traffic a sale depends on', () => {
  it('is a prepaid network variant: its Grant is a bag filled with that limit', () => {
    expect(mustStateTraffic(FulfilmentKind.network_access, VariantBillingMode.prepaid)).toBe(true);
  });

  it('is not a metered one, which buys its bytes in blocks (ADR-0072), nor a feature', () => {
    expect(mustStateTraffic(FulfilmentKind.network_access, VariantBillingMode.metered)).toBe(false);
    expect(mustStateTraffic(FulfilmentKind.feature_access, VariantBillingMode.prepaid)).toBe(false);
  });
});

describe('sellsTrafficToday — what the shop and invoice create let through', () => {
  it('sells a network variant with a byte limit', () => {
    expect(sellsTrafficToday(network(traffic(50 * GIB)))).toBe(true);
  });

  it('refuses one with no traffic row: its Grant would be a 0-byte bag, never placed, refunded after an hour', () => {
    expect(sellsTrafficToday(network({}))).toBe(false);
  });

  it('sells unlimited: the panels place its configs with no limit (F-111-r)', () => {
    expect(sellsTrafficToday(network(traffic(0)))).toBe(true);
  });

  it('leaves a metered network variant and a feature variant alone', () => {
    expect(sellsTrafficToday(network({}, VariantBillingMode.metered))).toBe(true);
    expect(sellsTrafficToday({ fulfilmentKind: FulfilmentKind.feature_access, billingMode: VariantBillingMode.prepaid, quotas: {} })).toBe(true);
  });
});

describe('durationDays on the wire — 0 is unlimited, stored null (F-111-p)', () => {
  it('stores 0 days as null, and keeps a real duration', () => {
    expect(updateVariantSchema.parse({ durationDays: 0 }).durationDays).toBeNull();
    expect(updateVariantSchema.parse({ durationDays: 30 }).durationDays).toBe(30);
    expect(updateVariantSchema.parse({ durationDays: null }).durationDays).toBeNull();
    expect(updateVariantSchema.parse({}).durationDays).toBeUndefined();
  });

  it('still refuses a negative duration', () => {
    expect(updateVariantSchema.safeParse({ durationDays: -1 }).success).toBe(false);
  });
});
