/**
 * The wheel's odds are the user's own (F-707-u, user 2026-10-22).
 *
 * What broke silently before: a GB slot drawn for a user on an unlimited plan,
 * or a days slot for one whose services never end, was quietly turned into
 * «nothing» and the spin was spent — so the odds the page showed were false
 * for exactly those users. Now such a slot is out of their pick and shown at
 * 0%, and the view and the spin share one weighting, so what is shown is what
 * is drawn.
 */
import { GrantStatus, Prisma, SpinPrizeType } from '@prisma/client';

import { pickSlot } from './wheel-spin.service';
import { oddsFor, prizeReachOf, reachableSlots } from './prize-reach';

type G = { status: GrantStatus; trafficUnlimited: boolean; endsAt: Date | null };
const tx = (grants: G[]) =>
  ({ grant: { findMany: async ({ where }: { where: { status: GrantStatus } }) => grants.filter((g) => g.status === where.status) } }) as unknown as Prisma.TransactionClient;
const AT = new Date('2026-10-22T00:00:00Z');

const slot = (position: number, prizeType: SpinPrizeType, probabilityWeight: number) => ({ position, prizeType, probabilityWeight });
const WHEEL = [slot(1, SpinPrizeType.bonus_traffic_gb, 30), slot(2, SpinPrizeType.extra_days, 20), slot(3, SpinPrizeType.discount_coupon, 10), slot(4, SpinPrizeType.empty, 40)];

describe('prizeReachOf', () => {
  it('reaches GB through a capped active service, days through one that ends, coupons and free services always', async () => {
    const unlimitedForever = await prizeReachOf(tx([{ status: GrantStatus.active, trafficUnlimited: true, endsAt: null }]), 'u');
    expect([...unlimitedForever].sort()).toEqual([SpinPrizeType.discount_coupon, SpinPrizeType.empty, SpinPrizeType.free_grant].sort());
    const capped = await prizeReachOf(tx([{ status: GrantStatus.active, trafficUnlimited: false, endsAt: AT }]), 'u');
    expect(capped.has(SpinPrizeType.bonus_traffic_gb) && capped.has(SpinPrizeType.extra_days)).toBe(true);
    const lapsed = await prizeReachOf(tx([{ status: GrantStatus.expired, trafficUnlimited: false, endsAt: AT }]), 'u');
    expect(lapsed.has(SpinPrizeType.bonus_traffic_gb) || lapsed.has(SpinPrizeType.extra_days)).toBe(false);
  });
});

describe("a user's own odds", () => {
  const onlyCoupons = new Set<SpinPrizeType>([SpinPrizeType.discount_coupon, SpinPrizeType.empty, SpinPrizeType.free_grant]);

  it('shows an unreachable slot at 0% and re-weights the rest', () => {
    const odds = oddsFor(WHEEL, onlyCoupons);
    expect(WHEEL.map(odds)).toEqual(['0.00', '0.00', '20.00', '80.00']);
    expect(WHEEL.map(oddsFor(WHEEL, new Set(Object.values(SpinPrizeType))))).toEqual(['30.00', '20.00', '10.00', '40.00']);
  });

  it('never draws a slot it shows at 0%', () => {
    const drawable = reachableSlots(WHEEL, onlyCoupons);
    for (let roll = 0; roll < 50; roll++) expect(pickSlot(drawable, () => roll).prizeType).not.toMatch(/bonus_traffic_gb|extra_days/);
  });

  it('keeps every slot when none can be reached, so a spin still lands as before', () => {
    const gbOnly = [slot(1, SpinPrizeType.bonus_traffic_gb, 1)];
    expect(reachableSlots(gbOnly, onlyCoupons)).toEqual(gbOnly);
    expect(gbOnly.map(oddsFor(gbOnly, onlyCoupons))).toEqual(['0.00']);
  });
});
