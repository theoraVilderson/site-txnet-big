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

import { CeilingAllocatorService, DEFAULT_CONFIG_FLOOR_BYTES, allocateCeilings, type ConfigDemand } from './ceiling-allocator';

const MIB = BigInt(1024 * 1024);
const GRANT = '77777777-7777-4777-8777-777777777777';

const demand = (configId: string, servedBytes: bigint, capBytes: bigint | null = null): ConfigDemand => ({ configId, servedBytes, capBytes });
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
          demand(`c${i}`, BigInt(pick(2_000)) * MIB, next() < 0.4 ? BigInt(pick(1_500)) * MIB : null),
        );
        const hotConfigId = next() < 0.9 ? (configs[pick(configs.length)] as ConfigDemand).configId : null;
        const where = `seed ${seed}`;

        const allocation = allocateCeilings({ purchasedBytes, floorBytes: configFloor, hotConfigId, configs });
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

        // A bag big enough for everyone covers everyone: no config is starved
        // below what it has already served while bytes sit unallocated.
        const owed = sum(configs.map((c) => (c.capBytes === null ? c.servedBytes : c.servedBytes < c.capBytes ? c.servedBytes : c.capBytes)));
        if (owed <= purchasedBytes) {
          for (const config of configs) {
            const floorOf = config.capBytes === null ? config.servedBytes : config.servedBytes < config.capBytes ? config.servedBytes : config.capBytes;
            expect((ceilings.get(config.configId) as bigint) >= floorOf, `${where} ${config.configId} keeps what it served`).toBe(true);
          }
        }
      }
    });
  });
});

type ConfigRow = { id: string; grantId: string; status: string; allocatedCeilingBytes: bigint | null };

/** A store, not a list of expected calls — the shape `block-purchase.spec.ts` uses. */
function fakeTx(options: { purchasedBytes: bigint; configs: ConfigRow[]; served: Record<string, bigint>; caps?: Record<string, { dataCapBytes: bigint; isActive: boolean }> }) {
  const rows = options.configs.map((c) => ({ ...c }));
  const tx = {
    grant: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === GRANT ? { id: GRANT, purchasedBytes: options.purchasedBytes } : null) },
    config: {
      findMany: async () =>
        rows.map((row) => ({
          id: row.id,
          allocatedCeilingBytes: row.allocatedCeilingBytes,
          counterState: options.served[row.id] === undefined ? null : { lifetimeUpBytes: options.served[row.id], lifetimeDownBytes: BigInt(0) },
          subAccount: options.caps?.[row.id] ?? null,
        })),
      update: async ({ where, data }: { where: { id: string }; data: { allocatedCeilingBytes: bigint } }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('no config');
        row.allocatedCeilingBytes = data.allocatedCeilingBytes;
        return row;
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, rows };
}

describe('CeilingAllocatorService.rebalance', () => {
  const service = () => new CeilingAllocatorService({} as never);
  const config = (id: string): ConfigRow => ({ id, grantId: GRANT, status: 'active', allocatedCeilingBytes: null });

  it('writes each config its share of what the Grant bought', async () => {
    const { tx, rows } = fakeTx({
      purchasedBytes: BigInt(1000) * MIB,
      configs: [config('hot'), config('cold')],
      served: { hot: BigInt(200) * MIB, cold: BigInt(50) * MIB },
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

    const allocation = await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

    expect(allocation.written).toBe(0);
  });

  it('answers a missing Grant as a refusal, not a crash', async () => {
    const { tx } = fakeTx({ purchasedBytes: BigInt(0), configs: [], served: {} });
    await expect(service().rebalance(tx, { grantId: 'other' })).rejects.toMatchObject({ reason: 'grant_not_found' });
  });

  it('uses the shipped floor when the caller names none', async () => {
    const { tx, rows } = fakeTx({
      purchasedBytes: DEFAULT_CONFIG_FLOOR_BYTES * BigInt(4),
      configs: [config('a'), config('b')],
      served: { a: BigInt(0), b: BigInt(0) },
    });

    await service().rebalance(tx, { grantId: GRANT, hotConfigId: 'a' });

    expect(rows.find((r) => r.id === 'b')?.allocatedCeilingBytes).toBe(DEFAULT_CONFIG_FLOOR_BYTES);
  });
});
