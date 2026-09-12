import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { Mock } from 'vitest';
import { answered, FxRatePoller } from './fx-rate.poller';
import { FxSource } from './fx-source';

/**
 * F-0603 is one step of the loop and it is the step that must not be able to
 * hurt anything: **query every active source concurrently, give each of them
 * three seconds, and come back with an answer per source whatever happened.**
 *
 * Three properties are worth a test here, and they are the three that decide
 * whether the rest of the loop (F-0604's median, F-0605's deviation gate) is
 * given a fair sample or a distorted one:
 *
 * 1. **Concurrent, not serial.** Four sources at 3s each is a twelve-second
 *    job if it is a loop, and one slow exchange then delays every other
 *    source's reading by enough for them to be quotes of different moments.
 * 2. **Three seconds is a per-source deadline, not a total.** A source that
 *    hangs is discarded on its own; it never holds the others.
 * 3. **One broken source is one failed outcome, never a failed poll.** This is
 *    the same sentence as the catalog's "one broken API cannot move the
 *    price", one row earlier: F-0604 can only discard a bad answer if this
 *    step actually hands it the others.
 *
 * The rial normalisation is tested with the sources' own units because it is
 * the one arithmetic step here, and a toman source read as rial is a tenfold
 * error that F-0605's 5% band would reject for ever without saying why.
 */
describe('FxRatePoller', () => {
  const D = (v: string) => new Prisma.Decimal(v);

  const configWith = (values: Record<string, unknown> = {}) =>
    ({
      get: <T>(key: string, fallback?: T) =>
        (values[key] as T) ?? (fallback as T),
    }) as unknown as ConfigService;

  /** A source whose parse step is trivial, so the test is about the poller. */
  const source = (
    key: string,
    unit: 'rial' | 'toman',
    url = `https://${key}.test/orderbook`,
  ): FxSource => ({
    key,
    url,
    unit,
    parse: (body: unknown) => {
      const b = body as { bid: string; ask: string };
      return { bestBid: D(b.bid), bestAsk: D(b.ask) };
    },
  });

  const answer = (body: unknown, status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;

  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('takes the mid of best bid and ask and normalises a rial source as it stands', async () => {
    fetchMock.mockResolvedValue(answer({ bid: '1000000', ask: '1002000' }));

    const [outcome] = await new FxRatePoller(configWith()).poll([
      source('nobitex', 'rial'),
    ]);

    expect(outcome.ok).toBe(true);
    if (!answered(outcome)) throw new Error('unreachable');
    expect(outcome.rialPerUsdt.toString()).toBe('1001000');
  });

  it('multiplies a toman source by ten, because the band gate cannot tell a unit error from a crash', async () => {
    fetchMock.mockResolvedValue(answer({ bid: '100000', ask: '100200' }));

    const [outcome] = await new FxRatePoller(configWith()).poll([
      source('tabdeal', 'toman'),
    ]);

    if (!answered(outcome)) throw new Error('unreachable');
    expect(outcome.rialPerUsdt.toString()).toBe('1001000');
  });

  it('queries every source at once rather than one after another', async () => {
    const inFlight = { now: 0, max: 0 };
    fetchMock.mockImplementation(async () => {
      inFlight.max = Math.max(inFlight.max, ++inFlight.now);
      await new Promise((r) => setTimeout(r, 5));
      inFlight.now--;
      return answer({ bid: '1000000', ask: '1000000' });
    });

    const sources = ['a', 'b', 'c', 'd'].map((k) => source(k, 'rial'));
    const outcomes = await new FxRatePoller(configWith()).poll(sources);

    expect(outcomes).toHaveLength(4);
    expect(inFlight.max).toBe(4);
  });

  it('gives each source its own three-second deadline and discards only the one that overran', async () => {
    const aborted: string[] = [];
    fetchMock.mockImplementation(
      (url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          if (url.includes('slow')) {
            init.signal.addEventListener('abort', () => {
              aborted.push(url);
              reject(new DOMException('aborted', 'AbortError'));
            });
            return;
          }
          resolve(answer({ bid: '1000000', ask: '1000000' }));
        }),
    );

    // The deadline is the poller's own timer, so the clock is the test's to
    // move. Nothing here waits three real seconds.
    vi.useFakeTimers();
    const poll = new FxRatePoller(configWith()).poll([
      source('slow', 'rial', 'https://slow.test/orderbook'),
      source('quick', 'rial'),
    ]);
    await vi.advanceTimersByTimeAsync(3_000);

    const outcomes = await poll;

    expect(aborted).toEqual(['https://slow.test/orderbook']);
    expect(outcomes.find((o) => o.source === 'slow')).toMatchObject({
      ok: false,
    });
    expect(outcomes.find((o) => o.source === 'quick')).toMatchObject({
      ok: true,
    });
  });

  it('reports a refusal, an unparseable body and a nonsense quote as failures, not as an exception', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('refuses')) return answer({}, 503);
      if (url.includes('garbles')) return answer({ bid: 'not-a-number', ask: '1' });
      if (url.includes('crosses')) return answer({ bid: '1002000', ask: '1000000' });
      return answer({ bid: '1000000', ask: '1000000' });
    });

    const outcomes = await new FxRatePoller(configWith()).poll([
      source('refuses', 'rial', 'https://refuses.test/orderbook'),
      source('garbles', 'rial', 'https://garbles.test/orderbook'),
      source('crosses', 'rial', 'https://crosses.test/orderbook'),
      source('healthy', 'rial'),
    ]);

    expect(outcomes.filter((o) => !o.ok)).toHaveLength(3);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    // A crossed book is a quote, not an error, which is why it has to be
    // named: bid above ask means the two sides were read at different moments
    // or the array order is not what the parser assumed.
    expect(outcomes.find((o) => o.source === 'crosses')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('crossed'),
    });
  });
});
