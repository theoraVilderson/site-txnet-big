/**
 * A lottery's draw (F-707-l, ADR-0111 point 5).
 *
 * What would break silently here, and nowhere else:
 *  - a permutation the verify page cannot redo: `lotteryPlaces` is the
 *    algorithm written down in `shared-core`; a reference built here from
 *    Node's own HMAC must give the same places, so the text and the code
 *    cannot drift apart;
 *  - a biased pick: `below(m)` rejects the words past the last whole multiple
 *    of m, so every ticket is equally likely;
 *  - a draw made over a list that is not the one hashed at the freeze, or made
 *    twice: the hash is recomputed and must match, and a lottery is drawn
 *    only while `frozen`, under its row lock;
 *  - a result written without its publishing, or a seed that cannot be opened
 *    drawn anyway: winners, `drawnAt`, `publishedAt` and `drawn` go together
 *    or not at all.
 */
import { createHash, createHmac } from 'node:crypto';

import { LOTTERY_ALGORITHM, drawPermutation, lotteryListHash, lotteryPlaces } from '@txnet-backend/shared-core';
import { LotteryStatus } from '@prisma/client';

import { LotteryDrawService } from './lottery-draw.service';

const SEED = 'ab'.repeat(32);
const HASH = 'cd'.repeat(32);

/** The algorithm as `lottery-draw.ts`'s doc states it, on Node's HMAC: a second, independent reading of the text. */
function reference(seedHex: string, listHash: string, n: number, k: number): number[] {
  const words: number[] = [];
  let block = 0;
  const next = () => {
    if (words.length === 0) {
      const mac = createHmac('sha256', Buffer.from(seedHex, 'hex')).update(`${listHash}:${block}`).digest();
      block += 1;
      for (let i = 0; i < 32; i += 4) words.push(mac.readUInt32BE(i));
    }
    return words.shift() as number;
  };
  const a = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = 0; i < Math.min(n, k); i += 1) {
    const m = n - i;
    const limit = 2 ** 32 - (2 ** 32 % m);
    let u = next();
    while (u >= limit) u = next();
    const j = i + (u % m);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, k));
}

describe('the draw algorithm (shared-core, run again by the verify page)', () => {
  it('is named as the close records it', () => {
    expect(LOTTERY_ALGORITHM).toBe('hmac-sha256-fisher-yates-v1');
  });

  it.each([
    [1, 1],
    [5, 3],
    [10, 10],
    [100, 7],
    [3, 9],
  ])('gives, for %i tickets and %i places, what its written definition gives', async (n, k) => {
    expect(await drawPermutation(SEED, HASH, n, k)).toEqual(reference(SEED, HASH, n, k));
  });

  it('runs past one HMAC block and keeps agreeing', async () => {
    // 40 places need more than the 8 words of block 0.
    expect(await drawPermutation(SEED, HASH, 1000, 40)).toEqual(reference(SEED, HASH, 1000, 40));
  });

  it('gives distinct tickets, all in 1..n, and the same ones every time', async () => {
    const a = await drawPermutation(SEED, HASH, 50, 20);
    expect(new Set(a).size).toBe(20);
    expect(a.every((t) => t >= 1 && t <= 50)).toBe(true);
    expect(await drawPermutation(SEED, HASH, 50, 20)).toEqual(a);
  });

  it('changes with the seed and with the list', async () => {
    const a = await drawPermutation(SEED, HASH, 1000, 5);
    expect(await drawPermutation('ac'.repeat(32), HASH, 1000, 5)).not.toEqual(a);
    expect(await drawPermutation(SEED, 'ce'.repeat(32), 1000, 5)).not.toEqual(a);
  });

  it('picks each ticket about equally often', async () => {
    const counts = [0, 0, 0];
    for (let s = 0; s < 3000; s += 1) {
      const seed = createHash('sha256').update(`seed-${s}`).digest('hex');
      const [first] = await drawPermutation(seed, HASH, 3, 1);
      counts[first - 1] += 1;
    }
    // Expected 1000 each; 4.5 standard deviations is ±116.
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(116);
  });

  it('hands out the places: prizes in rank order, each its count, then the reserves', async () => {
    const places = await lotteryPlaces({ seed: SEED, listHash: HASH, entrantCount: 10, prizes: [{ rank: 2, winnersCount: 2 }, { rank: 1, winnersCount: 1 }], reservesCount: 2 });
    const order = reference(SEED, HASH, 10, 5);
    expect(places).toEqual([
      { position: 1, ticketNumber: order[0], prizeRank: 1 },
      { position: 2, ticketNumber: order[1], prizeRank: 2 },
      { position: 3, ticketNumber: order[2], prizeRank: 2 },
      { position: 4, ticketNumber: order[3], prizeRank: null },
      { position: 5, ticketNumber: order[4], prizeRank: null },
    ]);
  });

  it('with fewer tickets than places, leaves the last prizes and the reserves unfilled', async () => {
    const places = await lotteryPlaces({ seed: SEED, listHash: HASH, entrantCount: 2, prizes: [{ rank: 1, winnersCount: 1 }, { rank: 2, winnersCount: 3 }], reservesCount: 5 });
    expect(places.map((p) => p.prizeRank)).toEqual([1, 2]);
    expect(await lotteryPlaces({ seed: SEED, listHash: HASH, entrantCount: 0, prizes: [{ rank: 1, winnersCount: 1 }], reservesCount: 1 })).toEqual([]);
  });

  it('hashes the list as the close has always hashed it', async () => {
    const LOT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
    const expected = createHash('sha256').update(`txnet-lottery-list-v1\n${LOT}\n1:e-1\n2:e-2\n`).digest('hex');
    expect(await lotteryListHash(LOT, [{ ticketNumber: 2, entrantId: 'e-2' }, { ticketNumber: 1, entrantId: 'e-1' }])).toBe(expected);
  });
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const AT = new Date('2026-10-10T12:01:00Z');

async function build(o: { status?: LotteryStatus; tickets?: number; prizes?: Array<{ id: string; rank: number; winnersCount: number }>; reserves?: number; tamper?: boolean; seal?: 'ok' | 'fails' } = {}) {
  const lot = { id: LOT, tenantId: TENANT, status: o.status ?? LotteryStatus.frozen, reservesCount: o.reserves ?? 1 };
  const entrants = Array.from({ length: o.tickets ?? 6 }, (_, i) => ({ id: `e-${i + 1}`, ticketNumber: i + 1 }));
  const published = entrants.map((e) => ({ ticketNumber: e.ticketNumber, entrantId: e.id }));
  // Tampered: the list read back differs by one entrant from the list the freeze hashed.
  const listHash = await lotteryListHash(LOT, o.tamper ? [...published.slice(1), { ticketNumber: 1, entrantId: 'e-x' }] : published);
  const draw: Record<string, unknown> = { lotteryId: LOT, tenantId: TENANT, entrantCount: entrants.length, listHash, seedSealed: { kekId: 'kek-1' }, algorithm: LOTTERY_ALGORITHM, drawnAt: null, publishedAt: null };
  const prizes = o.prizes ?? [{ id: 'p-1', rank: 1, winnersCount: 1 }, { id: 'p-2', rank: 2, winnersCount: 2 }];
  const winners: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async (strings: TemplateStringsArray) => {
      expect(strings.join('?')).toContain('FOR UPDATE');
      events.push('lock');
      return lot.status === LotteryStatus.frozen ? [lot] : [];
    },
    lotteryDraw: {
      findUnique: async () => draw,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        events.push('draw');
        Object.assign(draw, data);
        return draw;
      },
    },
    lotteryEntrant: { findMany: async () => entrants },
    lotteryPrize: { findMany: async () => prizes },
    lotteryWinner: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        events.push('winners');
        winners.push(...data);
        return { count: data.length };
      },
    },
    lottery: {
      updateMany: async ({ where, data }: { where: { status: LotteryStatus }; data: { status: LotteryStatus } }) => {
        events.push('drawn');
        if (lot.status !== where.status) return { count: 0 };
        lot.status = data.status;
        return { count: 1 };
      },
    },
  };
  // A transaction that keeps nothing when its body throws, as Postgres does.
  const prisma = {
    $transaction: async (fn: (t: typeof tx) => unknown) => {
      const before = { lot: { ...lot }, draw: { ...draw }, winners: winners.length };
      try {
        return await fn(tx);
      } catch (e) {
        Object.assign(lot, before.lot);
        Object.assign(draw, before.draw);
        winners.length = before.winners;
        throw e;
      }
    },
  };
  const crossTenant = { lottery: { findMany: async () => (lot.status === LotteryStatus.frozen ? [{ id: LOT, tenantId: TENANT }] : []) } };
  const seeds = {
    open: () => {
      if (o.seal === 'fails') throw new Error('kek-1 is not held');
      return SEED;
    },
  };
  const service = new LotteryDrawService(prisma as never, crossTenant as never, seeds as never);
  return { service, lot, draw, winners, events, listHash };
}

describe('LotteryDrawService.drawDue', () => {
  it('draws a frozen lottery once: winners by rank, then reserves; drawn and published together', async () => {
    const { service, lot, draw, winners, events, listHash } = await build();
    expect(await service.drawDue(AT)).toEqual({ scanned: 1, drawn: 1, failed: 0 });

    const order = reference(SEED, listHash, 6, 4);
    expect(winners.map((w) => [w.position, w.entrantId, w.prizeId])).toEqual([
      [1, `e-${order[0]}`, 'p-1'],
      [2, `e-${order[1]}`, 'p-2'],
      [3, `e-${order[2]}`, 'p-2'],
      [4, `e-${order[3]}`, null],
    ]);
    expect(winners.every((w) => w.tenantId === TENANT && w.lotteryId === LOT)).toBe(true);
    expect(draw).toMatchObject({ drawnAt: AT, publishedAt: AT });
    expect(lot.status).toBe(LotteryStatus.drawn);
    expect(events).toEqual(['lock', 'winners', 'draw', 'drawn']);

    // A second run finds nothing to draw.
    expect(await service.drawDue(AT)).toEqual({ scanned: 0, drawn: 0, failed: 0 });
    expect(winners).toHaveLength(4);
  });

  it('draws an empty list: no winners, still drawn and published', async () => {
    const { service, lot, draw, winners } = await build({ tickets: 0 });
    expect(await service.drawDue(AT)).toEqual({ scanned: 1, drawn: 1, failed: 0 });
    expect(winners).toEqual([]);
    expect(draw).toMatchObject({ drawnAt: AT, publishedAt: AT });
    expect(lot.status).toBe(LotteryStatus.drawn);
  });

  it('refuses a list that does not hash to what the freeze recorded, and keeps it frozen', async () => {
    const { service, lot, draw, winners } = await build({ tamper: true });
    expect(await service.drawDue(AT)).toEqual({ scanned: 1, drawn: 0, failed: 1 });
    expect(winners).toEqual([]);
    expect(draw).toMatchObject({ drawnAt: null, publishedAt: null });
    expect(lot.status).toBe(LotteryStatus.frozen);
  });

  it('leaves the lottery frozen, to be drawn next minute, when its seed cannot be opened', async () => {
    const { service, lot, winners } = await build({ seal: 'fails' });
    expect(await service.drawDue(AT)).toEqual({ scanned: 1, drawn: 0, failed: 1 });
    expect(winners).toEqual([]);
    expect(lot.status).toBe(LotteryStatus.frozen);
  });
});
