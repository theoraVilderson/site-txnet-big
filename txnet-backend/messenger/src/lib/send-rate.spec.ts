import { BOT_SEND_PER_SEC, BotSendPacer, SendRateStore } from './send-rate';

/**
 * The ceiling is the one thing a bulk run cannot discover safely (ADR-0066).
 * Before this, every send found the limit by hitting it: the platform answered
 * 429 and only then did the sender back off — and a platform that is flooded
 * repeatedly answers with a ban rather than another 429, which is exactly what
 * §9.8 exists to survive.
 *
 * These tests pin the three things a caller depends on: the budget is per bot,
 * a refusal looks like the platform's own refusal, and an app that binds no
 * store still sends.
 */
describe('BotSendPacer', () => {
  /** A store that counts in memory the way Redis counts: INCR per key. */
  const countingStore = (): SendRateStore & { keys: string[] } => {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    return {
      keys,
      incrementWithTtl: async (key: string) => {
        keys.push(key);
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      },
    };
  };

  const pacer = (store?: SendRateStore, perSec?: Partial<Record<'telegram' | 'bale', number>>) =>
    new BotSendPacer(store ?? null, {
      get: (key: string, fallback: number) =>
        key === 'TELEGRAM_SEND_PER_SEC'
          ? (perSec?.telegram ?? fallback)
          : key === 'BALE_SEND_PER_SEC'
            ? (perSec?.bale ?? fallback)
            : fallback,
    } as never);

  it('lets a send through while the tenant is under its ceiling', async () => {
    const p = pacer(countingStore(), { telegram: 3 });

    expect(await p.take('t1', 'telegram')).toBeNull();
    expect(await p.take('t1', 'telegram')).toBeNull();
    expect(await p.take('t1', 'telegram')).toBeNull();
  });

  it('refuses the send over the ceiling as the platform would — a retry_after, not a failure', async () => {
    const p = pacer(countingStore(), { telegram: 2 });

    await p.take('t1', 'telegram');
    await p.take('t1', 'telegram');

    // A number of seconds, never `null`: `null` is this API's "go ahead", and a
    // caller reading it as "no wait given" would send anyway.
    expect(await p.take('t1', 'telegram')).toBe(1);
  });

  it('counts one budget per (tenant x platform) — a ban is a bot`s, not a campaign`s', async () => {
    const store = countingStore();
    const p = pacer(store, { telegram: 1, bale: 1 });

    expect(await p.take('t1', 'telegram')).toBeNull();
    // Same tenant, other platform: a different bot, so a different allowance.
    expect(await p.take('t1', 'bale')).toBeNull();
    // Other tenant, same platform: another tenant's own bot and token.
    expect(await p.take('t2', 'telegram')).toBeNull();
    // ...and the first one is now spent.
    expect(await p.take('t1', 'telegram')).toBe(1);

    expect(new Set(store.keys).size).toBe(3);
  });

  it('builds the key through the registry, so the counter is readable in the keyspace', async () => {
    const store = countingStore();
    await pacer(store).take('t1', 'telegram');

    // C-03/C-05: the bucket is a declared name and the prefix is a builder's.
    expect(store.keys[0]).toContain('bot:send');
    expect(store.keys[0]).toContain('t1:telegram');
  });

  it('sends unpaced when no store is bound — an app without Redis still works', async () => {
    const p = pacer(undefined, { telegram: 1 });

    expect(await p.take('t1', 'telegram')).toBeNull();
    expect(await p.take('t1', 'telegram')).toBeNull();
  });

  it('carries a documented default ceiling for every platform', () => {
    // A number with no source is not a ceiling (`capabilities.ts`'s rule).
    for (const platform of ['telegram', 'bale'] as const) {
      expect(BOT_SEND_PER_SEC[platform]).toBeGreaterThan(0);
    }
    // Bale's is unconfirmed against its docs, so it may never be the looser one.
    expect(BOT_SEND_PER_SEC.bale).toBeLessThanOrEqual(BOT_SEND_PER_SEC.telegram);
  });
});
