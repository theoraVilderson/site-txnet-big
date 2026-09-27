import { GrantStatus, VariantBillingMode } from '@prisma/client';
import { remainingLabel } from '@txnet-backend/shared-core';

import { usageThresholdCrossed } from './usage-threshold';

/**
 * Usage thresholds (F-601-d): which level, if any, one charge crossed.
 *
 * The rule is on trial as arithmetic over the period's bag, because that is
 * where it goes wrong: a renewal keeps Quota and Used cumulative (entitlement
 * invariant 16), so a percentage of the cumulative figures would tell "50%"
 * the day after a renewal of a Grant that was at 96%.
 */

const GIB = BigInt(1024 ** 3);

function grant(over: Partial<Parameters<typeof usageThresholdCrossed>[0]> = {}) {
  return {
    status: GrantStatus.active,
    billingMode: VariantBillingMode.prepaid,
    trafficUnlimited: false,
    purchasedBytes: 100n * GIB,
    usagePeriodFromBytes: 0n,
    consumedBytes: 0n,
    ...over,
  };
}

describe('usageThresholdCrossed', () => {
  it('tells each level on the charge that crosses it, and nothing between', () => {
    expect(usageThresholdCrossed(grant({ consumedBytes: 50n * GIB }), GIB)).toEqual({ level: 50, remainingBytes: 50n * GIB });
    expect(usageThresholdCrossed(grant({ consumedBytes: 60n * GIB }), GIB)).toBeNull();
    expect(usageThresholdCrossed(grant({ consumedBytes: 80n * GIB + 1n }), 2n)).toEqual({ level: 80, remainingBytes: 20n * GIB - 1n });
    expect(usageThresholdCrossed(grant({ consumedBytes: 95n * GIB }), 1n)).toEqual({ level: 95, remainingBytes: 5n * GIB });
  });

  it('tells only the highest level one charge jumped past', () => {
    expect(usageThresholdCrossed(grant({ consumedBytes: 85n * GIB }), 45n * GIB)).toMatchObject({ level: 80 });
  });

  it('tells nothing once the bag is spent — that is the cutoff notice, not a threshold', () => {
    expect(usageThresholdCrossed(grant({ consumedBytes: 101n * GIB }), 10n * GIB)).toBeNull();
    expect(usageThresholdCrossed(grant({ consumedBytes: 100n * GIB }), 10n * GIB)).toBeNull();
  });

  it("measures from the period's start after a renewal, not from the cumulative Quota", () => {
    // 96 GiB used of 100, renewed by 100: the period has 104 GiB to spend.
    const renewed = { purchasedBytes: 200n * GIB, usagePeriodFromBytes: 96n * GIB };
    expect(usageThresholdCrossed(grant({ ...renewed, consumedBytes: 101n * GIB }), GIB)).toBeNull();
    expect(usageThresholdCrossed(grant({ ...renewed, consumedBytes: 148n * GIB }), GIB)).toEqual({ level: 50, remainingBytes: 52n * GIB });
  });

  it('tells nothing for a Grant with no bag to measure against', () => {
    const crossing = { consumedBytes: 50n * GIB };
    expect(usageThresholdCrossed(grant({ ...crossing, trafficUnlimited: true, purchasedBytes: 0n }), GIB)).toBeNull();
    expect(usageThresholdCrossed(grant({ ...crossing, billingMode: VariantBillingMode.metered }), GIB)).toBeNull();
    expect(usageThresholdCrossed(grant({ ...crossing, status: GrantStatus.suspended }), GIB)).toBeNull();
    // A renewal that carried a debt larger than it bought: nothing left to take a share of.
    expect(usageThresholdCrossed(grant({ purchasedBytes: 100n * GIB, usagePeriodFromBytes: 120n * GIB, consumedBytes: 121n * GIB }), GIB)).toBeNull();
    expect(usageThresholdCrossed(grant(crossing), 0n)).toBeNull();
  });
});

describe('remainingLabel', () => {
  it('reads as the user reads a volume', () => {
    expect(remainingLabel(52n * GIB + GIB / 2n)).toBe('52 GB');
    expect(remainingLabel(5n * GIB + (GIB * 35n) / 100n)).toBe('5.3 GB');
    expect(remainingLabel(GIB / 2n)).toBe('512 MB');
    expect(remainingLabel(1n)).toBe('1 MB');
  });
});
