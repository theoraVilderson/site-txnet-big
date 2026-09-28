import { Prisma } from '@prisma/client';
import { FxSourceOutcome } from './fx-rate.poller';
import { reduceFxReads, reduced } from './fx-rate.reducer';

/**
 * F-0604 is the row the catalog calls "what stops $100 of service from selling
 * for 600,000 rials because of one broken API response". It is three rules and
 * they only work together:
 *
 * 1. **Discard**, both a source that failed and a source that answered a number
 *    outside the hard band. An in-band-looking failure is the dangerous case:
 *    `0` and `1` parse, and a mean over them destroys the rate.
 * 2. **At least `minSources` must remain.** Fewer is no rate at all, not a
 *    best effort — a single surviving source *is* the "one broken API" the row
 *    exists to defend against, and there is nothing left to outvote it.
 * 3. **The median, never the mean.** The distinction only shows up when one
 *    reading is wrong, so every test that matters here has an outlier in it.
 *
 * The even-sample rule is tested explicitly because it is where "median" stops
 * being one obvious thing: this reducer takes the lower of the two middle
 * readings rather than averaging them, so the published rate is always a price
 * some exchange actually quoted. See the reducer's own comment.
 */
describe('reduceFxReads', () => {
  const D = (v: string) => new Prisma.Decimal(v);

  const read = (source: string, rial: string): FxSourceOutcome => ({
    source,
    ok: true,
    rate: D(rial),
    latencyMs: 10,
  });

  const failed = (source: string, reason = 'no answer'): FxSourceOutcome => ({
    source,
    ok: false,
    reason,
    latencyMs: 3_000,
  });

  /** The defaults the job passes, restated so a test reads on its own. */
  const band = {
    minSources: 2,
    sanityMin: D('100000'),
    sanityMax: D('10000000'),
  };

  it('takes the median of the surviving reads, not the mean', () => {
    // The mean of these three is 1,400,000 — dragged 27% by one bad source.
    // The median is the middle exchange and is untouched by it.
    const result = reduceFxReads(
      [
        read('nobitex', '1100000'),
        read('tabdeal', '1102000'),
        read('wallex', '2000000'),
      ],
      band,
    );

    expect(result.ok).toBe(true);
    if (!reduced(result)) return;
    expect(result.rate.toString()).toBe('1102000');
    expect(result.used).toEqual(['nobitex', 'tabdeal', 'wallex']);
  });

  it('discards a reading below the band and one above it', () => {
    const result = reduceFxReads(
      [
        read('nobitex', '1100000'),
        read('tabdeal', '1102000'),
        read('wallex', '1'), // an amount column read as a price
        read('bitpin', '99000000'), // a rial source parsed as toman
      ],
      band,
    );

    expect(result.ok).toBe(true);
    if (!reduced(result)) return;
    expect(result.used).toEqual(['nobitex', 'tabdeal']);
    expect(result.discarded).toEqual([
      { source: 'wallex', reason: 'out of band: 1' },
      { source: 'bitpin', reason: 'out of band: 99000000' },
    ]);
    expect(result.rate.toString()).toBe('1100000');
  });

  it('keeps a reading exactly on each edge of the band', () => {
    const result = reduceFxReads(
      [read('nobitex', '100000'), read('tabdeal', '10000000')],
      band,
    );

    expect(result.ok).toBe(true);
    if (!reduced(result)) return;
    expect(result.used).toHaveLength(2);
  });

  it('refuses to publish when fewer than minSources survive', () => {
    const result = reduceFxReads(
      [read('nobitex', '1100000'), failed('tabdeal'), read('wallex', '2')],
      band,
    );

    expect(result.ok).toBe(false);
    if (reduced(result)) return;
    expect(result.survivors).toBe(1);
    expect(result.reason).toContain('1 of 3');
    expect(result.reason).toContain('minSources 2');
    // The reason has to name what happened to each one, because "too few
    // sources" in a run log is not something an operator can act on.
    expect(result.discarded).toEqual([
      { source: 'tabdeal', reason: 'no answer' },
      { source: 'wallex', reason: 'out of band: 2' },
    ]);
  });

  it('refuses an empty poll rather than reading a median of nothing', () => {
    const result = reduceFxReads([], band);

    expect(result.ok).toBe(false);
    if (reduced(result)) return;
    expect(result.survivors).toBe(0);
  });

  it('takes the lower of the two middle readings on an even sample', () => {
    // Four sources, one of them wrong but inside the band. The mean is
    // 1,300,600; averaging the two middle readings would publish 1,101,500,
    // which no exchange quoted. The lower middle is a real quote.
    const result = reduceFxReads(
      [
        read('nobitex', '1100000'),
        read('tabdeal', '1103000'),
        read('wallex', '1999400'),
        read('bitpin', '1099000'),
      ],
      band,
    );

    expect(result.ok).toBe(true);
    if (!reduced(result)) return;
    expect(result.rate.toString()).toBe('1100000');
  });

  it('publishes a source-shaped sample of exactly minSources', () => {
    const result = reduceFxReads(
      [read('nobitex', '1100000'), read('tabdeal', '1102000')],
      band,
    );

    expect(result.ok).toBe(true);
    if (!reduced(result)) return;
    // The lower middle again, and deliberately so: with two sources there is
    // no majority, so the reducer publishes a quote rather than inventing the
    // midpoint of a disagreement it cannot resolve.
    expect(result.rate.toString()).toBe('1100000');
  });
});
