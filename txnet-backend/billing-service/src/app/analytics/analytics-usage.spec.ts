/**
 * Usage per meter (F-1001-n, ADR-0148, billing/contract.analytics.md "Every
 * product, not only VPN"). The ways this goes wrong quietly:
 *
 *  - **two meters added together.** Bytes and seconds are never one number:
 *    one card per meter, each in its own unit;
 *  - **a series out of step.** A meter's series is aligned with the answer's
 *    buckets — a bucket without use is 0, a bucket hidden from the platform's
 *    staff is null in every series (ADR-0104 (3));
 *  - **a delta that divides by zero.** `new` from zero, `null` with nothing
 *    compared — the same rule as every KPI.
 */
import { usageCards } from './analytics-usage';

const BUCKETS = ['2026-09-01', '2026-09-02', '2026-09-03'];
const row = (meterKey: string, bucket: string | null, quantity: number, grants = 1) => ({ meterKey, bucket, productId: null, quantity: BigInt(quantity), grants });

describe('usage cards', () => {
  it('answers one card per meter, in meter-key order, its total, previous, delta and a series per bucket', () => {
    const now = [row('vpn.traffic', '2026-09-01', 300, 2), row('vpn.traffic', '2026-09-03', 700, 3), row('vpn.unlimited.time', '2026-09-02', 60)];
    const before = [row('vpn.traffic', '2026-09-02', 500, 4)];
    expect(usageCards(now, before, BUCKETS, new Set())).toEqual([
      { meterKey: 'vpn.traffic', total: '1000', previous: '500', delta: 1, series: ['300', '0', '700'] },
      { meterKey: 'vpn.unlimited.time', total: '60', previous: '0', delta: 'new', series: ['0', '60', '0'] },
    ]);
  });

  it('keeps a meter used only before, nulls a hidden bucket, and has no previous with nothing compared', () => {
    const before = [row('vpn.config.regenerate', '2026-09-01', 4)];
    expect(usageCards([], before, BUCKETS, new Set())).toEqual([{ meterKey: 'vpn.config.regenerate', total: '0', previous: '4', delta: -1, series: ['0', '0', '0'] }]);
    expect(usageCards([row('vpn.traffic', '2026-09-02', 9)], null, BUCKETS, new Set(['2026-09-02']))).toEqual([{ meterKey: 'vpn.traffic', total: '9', previous: null, delta: null, series: ['0', null, '0'] }]);
  });
});
