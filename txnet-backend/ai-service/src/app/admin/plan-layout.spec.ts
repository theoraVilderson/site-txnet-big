import {
  LAYOUT_MIN_MEASURED,
  LAYOUT_WINDOW_DAYS,
  planLayout,
  type LayoutGrant,
  type LayoutPlan,
} from './plan-layout';

/**
 * F-1527 (ADR-0109 points 6, 9): plan-layout suggestions for the reseller,
 * from how much the users on each plan actually use per period — the Grants'
 * own meter readings, nothing else.
 *
 * The failures worth a spec: a suggestion from three users; a period measured
 * from a Grant a week old; a "smaller plan" the reseller already sells, or one
 * bigger than the plan it replaces; a "bigger plan" proposed beside a bigger
 * plan that exists; a price named (the engine never sets one); and a plan
 * nobody bought left unmentioned.
 */

const NOW = new Date('2026-10-07T10:00:00Z');
const DAY = 86_400_000;
const GIB = BigInt(1024 ** 3);
const since = new Date(NOW.getTime() - (LAYOUT_WINDOW_DAYS + 5) * DAY);

const plan = (variantId: string, gib: number, over: Partial<LayoutPlan> = {}): LayoutPlan => ({
  variantId,
  productId: 'p1',
  sku: variantId.toUpperCase(),
  nameKey: `catalog.${variantId}.name`,
  billingMode: 'prepaid',
  durationDays: 30,
  size: BigInt(gib) * GIB,
  unlimited: false,
  ...over,
});

/** `n` Grants on `variantId` using `gib` GiB each in the last 30 days. */
const users = (variantId: string, n: number, gib: number, over: Partial<LayoutGrant> = {}): LayoutGrant[] =>
  Array.from({ length: n }, () => ({
    variantId,
    usedInWindow: (BigInt(Math.round(gib * 100)) * GIB) / BigInt(100),
    firstReadingAt: since,
    purchasedBytes: BigInt(1000) * GIB,
    consumedBytes: BigInt(0),
    ...over,
  }));

const family = (plans: LayoutPlan[], grants: LayoutGrant[]) => {
  const out = planLayout(plans, grants, NOW);
  expect(out.families).toHaveLength(1);
  return out.families[0];
};

describe('the distribution per plan (F-1527)', () => {
  it('measures each plan from the Grants observed a whole window, scaled to the plan period', () => {
    const out = planLayout(
      [plan('v50', 50), plan('v90d', 150, { durationDays: 90 })],
      [...users('v50', 4, 10), ...users('v50', 1, 40), ...users('v50', 3, 5, { firstReadingAt: new Date(NOW.getTime() - 7 * DAY) }), ...users('v90d', 1, 10)],
      NOW,
    );
    const [v50, v90d] = out.families.map((f) => f.plans[0]);
    expect(v50).toMatchObject({ variantId: 'v50', active: 8, measured: 5, under: 4, atCap: 0 });
    expect(v50.usage).toEqual({ p25: (BigInt(10) * GIB).toString(), p50: (BigInt(10) * GIB).toString(), p75: (BigInt(10) * GIB).toString(), p90: (BigInt(40) * GIB).toString() });
    // 10 GiB in the 30-day window is 30 GiB over a 90-day period.
    expect(v90d).toMatchObject({ variantId: 'v90d', measured: 1, usage: { p50: (BigInt(30) * GIB).toString() } });
  });

  it('keeps one family per product, mode and length, plans by size; metered and unlimited plans have no bag to lay out', () => {
    const out = planLayout(
      [plan('v100', 100), plan('v20', 20), plan('w20', 20, { durationDays: 90 }), plan('m', 0, { billingMode: 'metered', size: null }), plan('u', 0, { size: null, unlimited: true })],
      [],
      NOW,
    );
    expect(out.families.map((f) => [f.productId, f.durationDays, f.plans.map((p) => p.variantId)])).toEqual([
      ['p1', 30, ['v20', 'v100']],
      ['p1', 90, ['w20']],
    ]);
  });

  it('counts a Grant whose bag ran out as at the cap, its real demand unmeasured', () => {
    const f = family([plan('v50', 50)], users('v50', 2, 30, { purchasedBytes: BigInt(50) * GIB, consumedBytes: BigInt(50) * GIB }));
    expect(f.plans[0]).toMatchObject({ measured: 2, atCap: 2 });
  });
});

describe('suggestions (F-1527)', () => {
  it(`suggests nothing from fewer than ${LAYOUT_MIN_MEASURED} measured users`, () => {
    const f = family([plan('v100', 100)], users('v100', LAYOUT_MIN_MEASURED - 1, 10));
    expect(f.suggestions).toEqual([]);
  });

  it('suggests a smaller plan when many use under 40%: their 75th percentile with headroom, rounded up, never a price', () => {
    const f = family([plan('v100', 100)], [...users('v100', 8, 12), ...users('v100', 4, 20), ...users('v100', 3, 80)]);
    expect(f.suggestions).toEqual([
      // 12 of 15 under 40 GiB; their 75th percentile is 20 GiB, × 1.25 = 25 GiB.
      { code: 'add_smaller', variantId: 'v100', users: 12, measured: 15, share: 0.8, size: (BigInt(25) * GIB).toString() },
    ]);
  });

  it('suggests no smaller plan the reseller already sells', () => {
    const f = family([plan('v30', 30), plan('v100', 100)], [...users('v100', 8, 12), ...users('v100', 4, 20), ...users('v100', 3, 80)]);
    expect(f.suggestions.filter((s) => s.code === 'add_smaller')).toEqual([]);
  });

  it('suggests a bigger plan only above the largest one, when a quarter of its users run out', () => {
    const capped = users('v50', 4, 50, { purchasedBytes: BigInt(50) * GIB, consumedBytes: BigInt(50) * GIB });
    const f = family([plan('v50', 50)], [...capped, ...users('v50', 8, 30)]);
    expect(f.suggestions).toEqual([{ code: 'add_bigger', variantId: 'v50', users: 4, measured: 12, share: 0.33, size: (BigInt(75) * GIB).toString(), demandCensored: true }]);

    const withBigger = family([plan('v50', 50), plan('v100', 100)], [...capped, ...users('v50', 8, 30)]);
    expect(withBigger.suggestions.filter((s) => s.code === 'add_bigger')).toEqual([]);
  });

  it('names a plan nobody holds, once the family has enough users to say so', () => {
    const f = family([plan('v20', 20), plan('v50', 50)], users('v50', LAYOUT_MIN_MEASURED, 30));
    expect(f.suggestions).toEqual([{ code: 'no_takers', variantId: 'v20', users: 0, measured: LAYOUT_MIN_MEASURED }]);
    expect(family([plan('v20', 20), plan('v50', 50)], users('v50', 3, 30)).suggestions).toEqual([]);
  });
});
