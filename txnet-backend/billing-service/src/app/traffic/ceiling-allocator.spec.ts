/**
 * The ceiling allocator (F-027-s; ADR-0072 rule 1).
 *
 * What breaks without anyone seeing it:
 *  - **free traffic on the second panel.** One bag spread over five configs
 *    needs one ceiling split five ways; five full ceilings would serve
 *    `5 x purchasedBytes` against one purchase, and every one of them would
 *    look correct on its own panel;
 *  - **a ceiling lowered under bytes already served.** Rebalancing towards the
 *    hot config must never take back what a cold one has already carried — the
 *    sum invariant is only a guarantee while every config's own served total
 *    stays under its own ceiling;
 *  - **a sub-account overrun.** `billing.SubAccount.dataCapBytes` caps a config
 *    (F-608) and is the *smaller* authority when it disagrees;
 *  - **a bag that drains through one config.** Every config keeps a floor, so
 *    the user's other devices still connect while the hot one runs.
 *
 * The first is a property, not a case: it has to hold for every shape of Grant,
 * so it is asserted over generated ones rather than over three hand-written
 * ones (ADR-0072 rule 1, entitlement invariant 8).
 */
import { Prisma } from '@prisma/client';

import { CeilingAllocatorService, DEFAULT_CONFIG_FLOOR_BYTES, IDLE_FLOOR_SECONDS, allocateCeilings, type ConfigDemand } from './ceiling-allocator';

const MIB = BigInt(1024 * 1024);
const GRANT = '77777777-7777-4777-8777-777777777777';
const USER = '88888888-8888-4888-8888-888888888888';
/** 2^30 — what one unit of `grant.meteredRate` prices (ADR-0073). */
const GIB_BYTES = BigInt(1024) * MIB;

const demand = (configId: string, servedBytes: bigint, capBytes: bigint | null = null, lineRateBps: bigint | null = null): ConfigDemand => ({
  configId,
  servedBytes,
  capBytes,
  lineRateBps,
});
const GBIT = BigInt(1_000_000_000);
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, BigInt(0));
const byId = (allocation: { ceilings: { configId: string; ceilingBytes: bigint }[] }) =>
  new Map(allocation.ceilings.map((c) => [c.configId, c.ceilingBytes]));

describe('allocateCeilings', () => {
  const floorBytes = BigInt(100) * MIB;

  it('spends the whole bag and no more, concentrating the rest on the hot config', () => {
    const purchasedBytes = BigInt(1000) * MIB;
    const allocation = allocateCeilings({
      purchasedBytes,
      floorBytes,
      hotConfigId: 'hot',
      configs: [demand('cold', BigInt(50) * MIB), demand('hot', BigInt(200) * MIB)],
    });

    const ceilings = byId(allocation);
    // cold keeps what it served plus its floor; the hot config takes the rest.
    expect(ceilings.get('cold')).toBe(BigInt(150) * MIB);
    expect(ceilings.get('hot')).toBe(BigInt(850) * MIB);
    expect(sum([...ceilings.values()])).toBe(purchasedBytes);
    expect(allocation.unallocatedBytes).toBe(BigInt(0));
  });

  it('never lowers a ceiling under the bytes that config has already served', () => {
    // The bag is barely larger than what the two configs have carried already.
    const allocation = allocateCeilings({
      purchasedBytes: BigInt(310) * MIB,
      floorBytes,
      hotConfigId: 'hot',
      configs: [demand('cold', BigInt(300) * MIB), demand('hot', BigInt(5) * MIB)],
    });

    const ceilings = byId(allocation);
    expect(ceilings.get('cold')).toBe(BigInt(300) * MIB);
    expect(ceilings.get('hot')).toBe(BigInt(10) * MIB);
  });

  it('serves what was served first, even when the bag cannot cover every config', () => {
    // 100 MiB bought, 400 MiB already carried across three configs: an overrun
    // the holds queue settles (ADR-0074). Nothing is handed out beyond the bag.
    const allocation = allocateCeilings({
      purchasedBytes: BigInt(100) * MIB,
      floorBytes,
      hotConfigId: 'c',
      configs: [demand('a', BigInt(200) * MIB), demand('b', BigInt(150) * MIB), demand('c', BigInt(50) * MIB)],
    });

    expect(sum(allocation.ceilings.map((c) => c.ceilingBytes))).toBe(BigInt(100) * MIB);
    expect(allocation.unallocatedBytes).toBe(BigInt(0));
  });

  it('lets the smaller sub-account cap win, and gives the freed bytes to the hot config', () => {
    const allocation = allocateCeilings({
      purchasedBytes: BigInt(1000) * MIB,
      floorBytes,
      hotConfigId: 'hot',
      configs: [demand('capped', BigInt(10) * MIB, BigInt(20) * MIB), demand('hot', BigInt(0))],
    });

    const ceilings = byId(allocation);
    expect(ceilings.get('capped')).toBe(BigInt(20) * MIB);
    expect(ceilings.get('hot')).toBe(BigInt(980) * MIB);
    expect(allocation.ceilings.find((c) => c.configId === 'capped')?.cappedBySubAccount).toBe(true);
  });

  it('reports bytes no ceiling can carry rather than handing them out anyway', () => {
    // Both configs are capped well under the bag: what is left is bought and
    // unservable, and the horizon (F-027-u) is what stops buying more.
    const allocation = allocateCeilings({
      purchasedBytes: BigInt(1000) * MIB,
      floorBytes,
      hotConfigId: 'a',
      configs: [demand('a', BigInt(0), BigInt(10) * MIB), demand('b', BigInt(0), BigInt(20) * MIB)],
    });

    expect(sum(allocation.ceilings.map((c) => c.ceilingBytes))).toBe(BigInt(30) * MIB);
    expect(allocation.unallocatedBytes).toBe(BigInt(970) * MIB);
  });

  it('gives every config its floor before the hot one takes anything extra', () => {
    const allocation = allocateCeilings({
      purchasedBytes: BigInt(250) * MIB,
      floorBytes,
      hotConfigId: 'hot',
      configs: [demand('hot', BigInt(0)), demand('a', BigInt(0)), demand('b', BigInt(0))],
    });

    // 250 MiB over three floors of 100: two are funded whole, the third takes
    // what is left. The hot config is first in line, never last.
    const ceilings = byId(allocation);
    expect(ceilings.get('hot')).toBe(BigInt(100) * MIB);
    expect(sum([...ceilings.values()])).toBe(BigInt(250) * MIB);
  });

  it('is decided by the input alone — same Grant, same allocation', () => {
    const input = {
      purchasedBytes: BigInt(777) * MIB,
      floorBytes,
      hotConfigId: 'b',
      configs: [demand('a', BigInt(3) * MIB), demand('b', BigInt(9) * MIB), demand('c', BigInt(1) * MIB, BigInt(4) * MIB)],
    };
    expect(allocateCeilings(input)).toEqual(allocateCeilings({ ...input, configs: [...input.configs].reverse() }));
  });

  it('allocates nothing at all when nothing has been bought', () => {
    const allocation = allocateCeilings({ purchasedBytes: BigInt(0), floorBytes, hotConfigId: null, configs: [demand('a', BigInt(0))] });
    expect(allocation.ceilings).toEqual([{ configId: 'a', ceilingBytes: BigInt(0), cappedBySubAccount: false }]);
  });

  /**
   * ADR-0072 rule 1 is an invariant with a property test, not a tuning. A
   * deterministic generator, so a failure is a seed and not a story: 400 Grants
   * of up to six configs, with overruns, sub-account caps, empty bags and
   * floors larger than the bag all reachable.
   */
  describe('an idle config keeps seconds of its line, not a fixed figure (ADR-0091)', () => {
    const bag = BigInt(50) * GIB_BYTES;
    const seconds = { floorBytes, floorSeconds: IDLE_FLOOR_SECONDS };
    const lineSeconds = (rateBps: bigint) => (rateBps / BigInt(8)) * BigInt(IDLE_FLOOR_SECONDS);

    it('keeps an idle config a few minutes of its gigabit line, and the rest goes to the one in use', () => {
      // Reported 2026-09-26: 50 GB on two inbounds read 49.9 / 0.09 on x-ui —
      // 100 MiB is under a second on a gigabit line, and the loop reacts in a minute.
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: null, configs: [demand('a', BigInt(0), null, GBIT), demand('b', BigInt(0), null, GBIT)] }),
      );
      expect(ceilings.get('b')).toBe(lineSeconds(GBIT));
      expect(ceilings.get('a')).toBe(bag - lineSeconds(GBIT));
    });

    it("sizes it by each config's own panel", () => {
      const rate = BigInt(100_000_000);
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: 'a', configs: [demand('a', BigInt(0), null, GBIT), demand('b', BigInt(0), null, rate)] }),
      );
      expect(ceilings.get('b')).toBe(lineSeconds(rate));
    });

    it('never keeps more than an even share, so a small bag splits evenly', () => {
      const small = BigInt(1) * GIB_BYTES;
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: small, ...seconds, hotConfigId: 'a', configs: [demand('a', BigInt(0), null, GBIT), demand('b', BigInt(0), null, GBIT)] }),
      );
      expect(ceilings.get('b')).toBe(small / BigInt(2));
      expect(ceilings.get('a')).toBe(small / BigInt(2));
    });

    it('splits evenly where the panel declares no line rate: nothing says how fast it drains', () => {
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: 'a', configs: [demand('a', BigInt(0)), demand('b', BigInt(0))] }),
      );
      expect(ceilings.get('b')).toBe(bag / BigInt(2));
    });

    it('keeps the fixed floor as the least, on a slow line', () => {
      const slow = BigInt(1_000_000);
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: 'a', configs: [demand('a', BigInt(0), null, GBIT), demand('b', BigInt(0), null, slow)] }),
      );
      expect(ceilings.get('b')).toBe(floorBytes);
    });

    it('is headroom above what the config has served, as the fixed floor is', () => {
      const served = BigInt(3) * GIB_BYTES;
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: 'a', configs: [demand('a', BigInt(0), null, GBIT), demand('b', served, null, GBIT)] }),
      );
      expect(ceilings.get('b')).toBe(served + lineSeconds(GBIT));
    });
  });

  describe('a consuming config is not held to an even share (F-027-cr, ADR-0091 amendment)', () => {
    const seconds = { floorBytes, floorSeconds: IDLE_FLOOR_SECONDS };
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => demand(id, BigInt(0), null, GBIT));

    it('gives the hot one of five gigabit configs half a 100 GB bag, not a fifth', () => {
      // At a fifth, a user at 25 MB/s was re-split over and over and cut
      // inside the 875 MB guard band through the last ~4 GB (F-027-co).
      const bag = BigInt(100) * GIB_BYTES;
      const ceilings = byId(allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: 'a', configs: five }));
      expect(ceilings.get('a')).toBe(bag / BigInt(2));
      for (const idle of ['b', 'c', 'd', 'e']) expect(ceilings.get(idle)).toBe(bag / BigInt(8));
    });

    it('still keeps an idle config its seconds of line where that is the smaller', () => {
      const bag = BigInt(500) * GIB_BYTES;
      const ceilings = byId(allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: 'a', configs: five }));
      const line = (GBIT / BigInt(8)) * BigInt(IDLE_FLOOR_SECONDS);
      expect(ceilings.get('b')).toBe(line);
      expect(ceilings.get('a')).toBe(bag - BigInt(4) * line);
    });

    it('splits evenly on a bulk pass, where nothing is hotter than the rest', () => {
      const bag = BigInt(100) * GIB_BYTES;
      const ceilings = byId(allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: null, configs: five }));
      for (const id of ['a', 'b', 'c', 'd', 'e']) expect(ceilings.get(id)).toBe(bag / BigInt(5));
    });
  });

  describe('a metered Grant keeps each config a reserve the wallet backs (F-027-cs, ADR-0091 amendment)', () => {
    const seconds = { floorBytes, floorSeconds: IDLE_FLOOR_SECONDS };
    const MBIT100 = BigInt(100_000_000);
    const lineSeconds = (rateBps: bigint) => (rateBps / BigInt(8)) * BigInt(IDLE_FLOOR_SECONDS);
    const hundred = Array.from({ length: 100 }, (unused, i) => demand(`c${String(i).padStart(3, '0')}`, BigInt(0), null, MBIT100));

    it('does not thin with the config count: 100 inbounds on 1 GiB each keep their seconds of line', () => {
      // Reported 2026-09-26: 5.4 MB each after a re-split, cut on the first connect.
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: GIB_BYTES, ...seconds, hotConfigId: 'c000', reserveBytes: BigInt(10) * GIB_BYTES, configs: hundred }),
      );
      for (const [id, ceiling] of ceilings) if (id !== 'c000') expect(ceiling, id).toBe(lineSeconds(MBIT100));
    });

    it('holds no more above what a config served than the wallet would buy', () => {
      const reserve = BigInt(50) * MIB;
      const served = BigInt(7) * MIB;
      const configs = [...hundred.slice(0, 99), demand('c099', served, null, MBIT100)];
      const ceilings = byId(allocateCeilings({ purchasedBytes: GIB_BYTES, ...seconds, hotConfigId: 'c000', reserveBytes: reserve, configs }));
      expect(ceilings.get('c001')).toBe(reserve);
      expect(ceilings.get('c099')).toBe(served + reserve);
    });

    it('never lowers what the bag already gave, and gives the hot config the reserve too', () => {
      const bag = BigInt(50) * GIB_BYTES;
      const two = [demand('a', BigInt(0), null, MBIT100), demand('b', BigInt(0), null, MBIT100)];
      const without = byId(allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: 'a', configs: two }));
      const withReserve = byId(allocateCeilings({ purchasedBytes: bag, ...seconds, hotConfigId: 'a', reserveBytes: GIB_BYTES, configs: two }));
      expect(withReserve).toEqual(without);

      const tiny = byId(allocateCeilings({ purchasedBytes: BigInt(10) * MIB, ...seconds, hotConfigId: 'a', reserveBytes: BigInt(10) * GIB_BYTES, configs: two }));
      expect(tiny.get('a')).toBe(lineSeconds(MBIT100));
    });

    it('takes the fixed floor where the panel declares no line rate', () => {
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: BigInt(10) * MIB, ...seconds, hotConfigId: 'a', reserveBytes: GIB_BYTES, configs: [demand('a', BigInt(0)), demand('b', BigInt(0))] }),
      );
      expect(ceilings.get('b')).toBe(floorBytes);
    });

    it('stops at the sub-account cap', () => {
      const cap = BigInt(20) * MIB;
      const ceilings = byId(
        allocateCeilings({ purchasedBytes: BigInt(10) * MIB, ...seconds, hotConfigId: 'a', reserveBytes: GIB_BYTES, configs: [demand('a', BigInt(0), null, MBIT100), demand('b', BigInt(0), cap, MBIT100)] }),
      );
      expect(ceilings.get('b')).toBe(cap);
    });

    it('reports the same unallocated bytes: the reserve is not the bag', () => {
      const configs = [demand('a', BigInt(0), BigInt(10) * MIB, MBIT100)];
      const allocation = allocateCeilings({ purchasedBytes: GIB_BYTES, ...seconds, hotConfigId: 'a', reserveBytes: GIB_BYTES, configs });
      expect(allocation.unallocatedBytes).toBe(GIB_BYTES - BigInt(10) * MIB);
    });
  });

  describe('over generated Grants (ADR-0072 rule 1)', () => {
    /** Mulberry32 — a seeded PRNG in four lines, so no dependency and no flake. */
    const rng = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    it('holds the sum, the served floor and the sub-account cap on every one', () => {
      for (let seed = 1; seed <= 400; seed++) {
        const next = rng(seed);
        const pick = (max: number) => Math.floor(next() * max);
        const purchasedBytes = BigInt(pick(5_000)) * MIB;
        const configFloor = BigInt(pick(300)) * MIB;
        const configs: ConfigDemand[] = Array.from({ length: 1 + pick(6) }, (unused, i) =>
          demand(
            `c${i}`,
            BigInt(pick(2_000)) * MIB,
            next() < 0.4 ? BigInt(pick(1_500)) * MIB : null,
            next() < 0.3 ? null : BigInt(pick(2_000)) * BigInt(1_000_000),
          ),
        );
        // Half the Grants in the seconds floor (ADR-0091), half in the fixed one.
        const floorSeconds = next() < 0.5 ? IDLE_FLOOR_SECONDS : undefined;
        const hotConfigId = next() < 0.9 ? (configs[pick(configs.length)] as ConfigDemand).configId : null;
        const where = `seed ${seed}`;

        const allocation = allocateCeilings({ purchasedBytes, floorBytes: configFloor, floorSeconds, hotConfigId, configs });
        const ceilings = byId(allocation);

        // The invariant itself: Σ ceilings ≤ purchasedBytes, always (entitlement invariant 8).
        expect(sum(allocation.ceilings.map((c) => c.ceilingBytes)), where).toBeLessThanOrEqual(purchasedBytes);
        // Nothing is lost between the ceilings and what was reported unservable.
        expect(sum(allocation.ceilings.map((c) => c.ceilingBytes)) + allocation.unallocatedBytes, where).toBeLessThanOrEqual(purchasedBytes);
        expect(allocation.ceilings, where).toHaveLength(configs.length);

        for (const config of configs) {
          const ceiling = ceilings.get(config.configId) as bigint;
          expect(ceiling >= BigInt(0), `${where} ${config.configId} not negative`).toBe(true);
          if (config.capBytes !== null) {
            expect(ceiling <= config.capBytes, `${where} ${config.configId} under its sub-account cap`).toBe(true);
          }
        }

        // F-027-w: the same split over a bigger bag — `purchasedBytes` plus
        // what the wallet would still buy — is what a graceful shutdown
        // raises each ceiling to. It has to be larger config by config, or a
        // shutdown would quietly *lower* one. Monotone in the bag by
        // construction; asserted here because the whole meaning of the column
        // rests on it (`config_wallet_backed_ceiling_extends`).
        const backed = byId(allocateCeilings({ purchasedBytes: purchasedBytes + BigInt(pick(5_000)) * MIB, floorBytes: configFloor, floorSeconds, hotConfigId, configs }));
        for (const config of configs) {
          const over = backed.get(config.configId) as bigint;
          expect(over >= (ceilings.get(config.configId) as bigint), `${where} ${config.configId} extends rather than lowers`).toBe(true);
        }

        // A bag big enough for everyone covers everyone: no config is starved
        // below what it has already served while bytes sit unallocated.
        const owed = sum(configs.map((c) => (c.capBytes === null ? c.servedBytes : c.servedBytes < c.capBytes ? c.servedBytes : c.capBytes)));
        // F-027-cr: an uncapped hot config gets at least half of what pass 1
        // left, however many idle configs share the bag with it.
        const hot = configs.find((c) => c.configId === hotConfigId);
        if (floorSeconds !== undefined && hot && hot.capBytes === null && owed <= purchasedBytes) {
          const headroom = (ceilings.get(hot.configId) as bigint) - hot.servedBytes;
          expect(headroom >= (purchasedBytes - owed) / BigInt(2), `${where} hot keeps half`).toBe(true);
        }
        if (owed <= purchasedBytes) {
          for (const config of configs) {
            const floorOf = config.capBytes === null ? config.servedBytes : config.servedBytes < config.capBytes ? config.servedBytes : config.capBytes;
            expect((ceilings.get(config.configId) as bigint) >= floorOf, `${where} ${config.configId} keeps what it served`).toBe(true);
          }
        }

        // F-027-cs: a metered Grant's reserve only ever raises a ceiling, by
        // at most the reserve above what the config served, never past a cap,
        // and leaves what the bag could not place exactly where it was.
        const reserveBytes = BigInt(pick(3_000)) * MIB;
        const reserved = allocateCeilings({ purchasedBytes, floorBytes: configFloor, floorSeconds, hotConfigId, reserveBytes, configs });
        expect(reserved.unallocatedBytes, where).toBe(allocation.unallocatedBytes);
        const raised = byId(reserved);
        for (const config of configs) {
          const base = ceilings.get(config.configId) as bigint;
          const ceiling = raised.get(config.configId) as bigint;
          expect(ceiling >= base, `${where} ${config.configId} reserve only raises`).toBe(true);
          if (ceiling > base) expect(ceiling <= config.servedBytes + reserveBytes, `${where} ${config.configId} by the reserve at most`).toBe(true);
          if (config.capBytes !== null) expect(ceiling <= config.capBytes, `${where} ${config.configId} reserve under its cap`).toBe(true);
        }
      }
    });
  });
});

type ConfigRow = { id: string; grantId: string; status: string; allocatedCeilingBytes: bigint | null; walletBackedCeilingBytes?: bigint | null };

/** A store, not a list of expected calls — the shape `block-purchase.spec.ts` uses. */
function fakeTx(options: {
  purchasedBytes: bigint;
  configs: ConfigRow[];
  served: Record<string, bigint>;
  caps?: Record<string, { dataCapBytes: bigint; isActive: boolean }>;
  /** `panel.maxLineRateBps` per config; absent is a panel that declares none. */
  rates?: Record<string, bigint>;
  /** `grant.meteredRate`; null makes the Grant prepaid, which has no wallet-backed extension. */
  meteredRate?: string | null;
  /** `wallet.cachedBalance`, in dollars. Undefined is a user with no wallet row. */
  balance?: string;
}) {
  const rows = options.configs.map((c) => ({ ...c }));
  const updated: string[] = [];
  const metered = options.meteredRate === undefined ? '1.00000000' : options.meteredRate;
  const tx = {
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === GRANT
          ? {
              id: GRANT,
              userId: USER,
              purchasedBytes: options.purchasedBytes,
              billingMode: metered === null ? 'prepaid' : 'metered',
              meteredRate: metered === null ? null : new Prisma.Decimal(metered),
            }
          : null,
    },
    wallet: { findUnique: async () => (options.balance === undefined ? null : { cachedBalance: new Prisma.Decimal(options.balance) }) },
    config: {
      findMany: async () =>
        rows.map((row) => ({
          id: row.id,
          allocatedCeilingBytes: row.allocatedCeilingBytes,
          walletBackedCeilingBytes: row.walletBackedCeilingBytes ?? null,
          counterState: options.served[row.id] === undefined ? null : { lifetimeUpBytes: options.served[row.id], lifetimeDownBytes: BigInt(0) },
          subAccount: options.caps?.[row.id] ?? null,
          panel: { maxLineRateBps: options.rates?.[row.id] ?? null },
        })),
      update: async ({ where, data }: { where: { id: string }; data: { allocatedCeilingBytes?: bigint; walletBackedCeilingBytes?: bigint } }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('no config');
        updated.push(where.id);
        if (data.allocatedCeilingBytes !== undefined) row.allocatedCeilingBytes = data.allocatedCeilingBytes;
        if (data.walletBackedCeilingBytes !== undefined) row.walletBackedCeilingBytes = data.walletBackedCeilingBytes;
        return row;
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, rows, updated };
}

describe('CeilingAllocatorService.rebalance', () => {
  const service = () => new CeilingAllocatorService({} as never);
  const config = (id: string): ConfigRow => ({ id, grantId: GRANT, status: 'active', allocatedCeilingBytes: null, walletBackedCeilingBytes: null });

  it('writes each config its share of what the Grant bought', async () => {
    const { tx, rows } = fakeTx({
      purchasedBytes: BigInt(1000) * MIB,
      configs: [config('hot'), config('cold')],
      served: { hot: BigInt(200) * MIB, cold: BigInt(50) * MIB },
      // A slow line: its seconds are under the floor, so the 100 MiB binds.
      rates: { hot: BigInt(1_000_000), cold: BigInt(1_000_000) },
    });

    const allocation = await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'hot', floorBytes: BigInt(100) * MIB });

    expect(sum(allocation.ceilings.map((c) => c.ceilingBytes))).toBe(BigInt(1000) * MIB);
    expect(rows.find((r) => r.id === 'cold')?.allocatedCeilingBytes).toBe(BigInt(150) * MIB);
    expect(rows.find((r) => r.id === 'hot')?.allocatedCeilingBytes).toBe(BigInt(850) * MIB);
  });

  it('counts a config with no counter row yet as having served nothing', async () => {
    const { tx, rows } = fakeTx({ purchasedBytes: BigInt(300) * MIB, configs: [config('fresh')], served: {} });

    await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'fresh' });

    expect(rows[0]?.allocatedCeilingBytes).toBe(BigInt(300) * MIB);
  });

  it('lets an active sub-account cap the config it is attached to', async () => {
    const { tx, rows } = fakeTx({
      purchasedBytes: BigInt(1000) * MIB,
      configs: [config('capped'), config('hot')],
      served: { capped: BigInt(0), hot: BigInt(0) },
      caps: { capped: { dataCapBytes: BigInt(20) * MIB, isActive: true } },
    });

    await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'hot' });

    expect(rows.find((r) => r.id === 'capped')?.allocatedCeilingBytes).toBe(BigInt(20) * MIB);
  });

  it('ignores a deactivated sub-account rather than reading its cap as zero', async () => {
    const { tx, rows } = fakeTx({
      purchasedBytes: BigInt(400) * MIB,
      configs: [config('a')],
      served: { a: BigInt(0) },
      caps: { a: { dataCapBytes: BigInt(20) * MIB, isActive: false } },
    });

    await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

    expect(rows[0]?.allocatedCeilingBytes).toBe(BigInt(400) * MIB);
  });

  it('writes only the configs whose share moved', async () => {
    const { tx, rows } = fakeTx({ purchasedBytes: BigInt(300) * MIB, configs: [config('a')], served: { a: BigInt(0) } });
    rows[0].allocatedCeilingBytes = BigInt(300) * MIB;
    // Both columns, because either one moving is a write (F-027-w).
    rows[0].walletBackedCeilingBytes = BigInt(300) * MIB;

    const allocation = await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

    expect(allocation.written).toBe(0);
  });

  it("writes a Grant's configs in id order, the order network-service locks them in (F-027-cv)", async () => {
    const { tx, updated } = fakeTx({
      purchasedBytes: BigInt(900) * MIB,
      configs: [config('c'), config('a'), config('b')],
      served: { a: BigInt(0), b: BigInt(0), c: BigInt(0) },
    });

    await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'c' });

    expect(updated).toEqual(['a', 'b', 'c']);
  });

  it('answers a missing Grant as a refusal, not a crash', async () => {
    const { tx } = fakeTx({ purchasedBytes: BigInt(0), configs: [], served: {} });
    await expect(service().rebalance(tx, { grantId: 'other' })).rejects.toMatchObject({ reason: 'grant_not_found' });
  });

  /**
   * F-027-w / ADR-0078. The collector is the only thing that reads a counter,
   * so from the moment it exits no ceiling rises for anyone — and it cannot
   * ask this service for a figure at that moment, because the deploy taking it
   * down is usually taking this one down too. So the figure is left in the row
   * ahead of time, refreshed in the same transaction as the allocation it
   * extends, and is never more than one pass stale.
   */
  describe('the figure a graceful shutdown raises a ceiling to', () => {
    it('extends the share by what the wallet would still buy', async () => {
      // 1 dollar per GiB, 4 dollars in the wallet: the bag the shutdown figure
      // is split over is what was bought plus four more gibibytes.
      const { tx, rows } = fakeTx({
        purchasedBytes: BigInt(1000) * MIB,
        configs: [config('a')],
        served: { a: BigInt(0) },
        meteredRate: '1.00000000',
        balance: '4.00',
      });

      await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

      expect(rows[0]?.allocatedCeilingBytes).toBe(BigInt(1000) * MIB);
      expect(rows[0]?.walletBackedCeilingBytes).toBe(BigInt(1000) * MIB + BigInt(4) * GIB_BYTES);
    });

    it('never writes one below the allocation it extends', async () => {
      // The database CHECKs this (`config_wallet_backed_ceiling_extends`); a
      // row that got under it would have a shutdown lowering every ceiling on
      // its way out.
      const { tx, rows } = fakeTx({
        purchasedBytes: BigInt(1000) * MIB,
        configs: [config('a'), config('b')],
        served: { a: BigInt(0), b: BigInt(0) },
        balance: '0.00',
      });

      await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

      for (const row of rows) {
        expect(row.walletBackedCeilingBytes).toBe(row.allocatedCeilingBytes);
      }
    });

    it('gives a prepaid Grant no extension at all', async () => {
      // Nothing prices a byte for it (ADR-0073), and nothing tops it up
      // either: a prepaid ceiling is the quota, and the collector being down
      // does not shrink it.
      const { tx, rows } = fakeTx({
        purchasedBytes: BigInt(500) * MIB,
        configs: [config('a')],
        served: { a: BigInt(0) },
        meteredRate: null,
        balance: '100.00',
      });

      await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

      expect(rows[0]?.walletBackedCeilingBytes).toBe(rows[0]?.allocatedCeilingBytes);
    });

    it('treats a user with no wallet row as a balance of zero', async () => {
      const { tx, rows } = fakeTx({ purchasedBytes: BigInt(500) * MIB, configs: [config('a')], served: { a: BigInt(0) } });

      await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

      expect(rows[0]?.walletBackedCeilingBytes).toBe(BigInt(500) * MIB);
    });

    it('keeps the sub-account cap over the larger bag too', async () => {
      // A cap is a cap. Money the user has does not buy past a limit somebody
      // set on that config (F-608), and a shutdown is not where that stops
      // being true.
      const { tx, rows } = fakeTx({
        purchasedBytes: BigInt(100) * MIB,
        configs: [config('capped')],
        served: { capped: BigInt(0) },
        caps: { capped: { dataCapBytes: BigInt(150) * MIB, isActive: true } },
        balance: '50.00',
      });

      await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'capped' });

      expect(rows[0]?.walletBackedCeilingBytes).toBe(BigInt(150) * MIB);
    });

    it('writes the row when only the shutdown figure moved', async () => {
      // The wallet changes far more often than the allocation does — every
      // top-up moves it while `purchasedBytes` stands still. A write gated on
      // the allocation alone would leave the shutdown figure at yesterday's
      // balance.
      const { tx, rows } = fakeTx({
        purchasedBytes: BigInt(300) * MIB,
        configs: [config('a')],
        served: { a: BigInt(0) },
        balance: '2.00',
      });
      rows[0].allocatedCeilingBytes = BigInt(300) * MIB;
      rows[0].walletBackedCeilingBytes = BigInt(300) * MIB;

      const allocation = await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

      expect(allocation.written).toBe(1);
      expect(rows[0]?.walletBackedCeilingBytes).toBe(BigInt(300) * MIB + BigInt(2) * GIB_BYTES);
    });
  });

  it('uses the shipped floor when the caller names none', async () => {
    const { tx, rows } = fakeTx({
      purchasedBytes: DEFAULT_CONFIG_FLOOR_BYTES * BigInt(4),
      configs: [config('a'), config('b')],
      served: { a: BigInt(0), b: BigInt(0) },
      // A slow line: its seconds are under the floor, so the floor is what binds.
      rates: { a: BigInt(1_000_000), b: BigInt(1_000_000) },
    });

    await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

    expect(rows.find((r) => r.id === 'b')?.allocatedCeilingBytes).toBe(DEFAULT_CONFIG_FLOOR_BYTES);
  });

  it("sizes an idle config's floor by its own panel's line rate (ADR-0091)", async () => {
    const bag = BigInt(50) * GIB_BYTES;
    const { tx, rows } = fakeTx({
      purchasedBytes: bag,
      configs: [config('a'), config('b')],
      served: { a: BigInt(0), b: BigInt(0) },
      rates: { a: GBIT, b: GBIT },
    });

    await service().rebalance(tx, { grantId: GRANT });

    const idle = (GBIT / BigInt(8)) * BigInt(IDLE_FLOOR_SECONDS);
    expect(rows.find((r) => r.id === 'b')?.allocatedCeilingBytes).toBe(idle);
    expect(rows.find((r) => r.id === 'a')?.allocatedCeilingBytes).toBe(bag - idle);
  });

  describe('the reserve a metered wallet backs (F-027-cs)', () => {
    const rate = BigInt(100_000_000);
    const line = (rate / BigInt(8)) * BigInt(IDLE_FLOOR_SECONDS);

    it('keeps an idle config its seconds of line past a small bag, while the wallet would buy them', async () => {
      const { tx, rows } = fakeTx({
        purchasedBytes: BigInt(100) * MIB,
        configs: [config('a'), config('b')],
        served: { a: BigInt(0), b: BigInt(0) },
        rates: { a: rate, b: rate },
        balance: '10.00',
      });

      await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

      const b = rows.find((r) => r.id === 'b');
      expect(b?.allocatedCeilingBytes).toBe(line);
      // The CHECK `config_wallet_backed_ceiling_extends` still holds.
      expect((b?.walletBackedCeilingBytes as bigint) >= line).toBe(true);
    });

    it('gives a prepaid Grant none: its bag is all there is', async () => {
      const bag = BigInt(100) * MIB;
      const { tx, rows } = fakeTx({
        purchasedBytes: bag,
        configs: [config('a'), config('b')],
        served: { a: BigInt(0), b: BigInt(0) },
        rates: { a: rate, b: rate },
        meteredRate: null,
        balance: '10.00',
      });

      await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

      expect(sum(rows.map((r) => r.allocatedCeilingBytes as bigint))).toBeLessThanOrEqual(bag);
    });
  });
});
