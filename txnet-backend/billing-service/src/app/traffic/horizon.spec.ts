/**
 * The hot loop's horizon (F-027-u, ADR-0072).
 *
 * What breaks without anyone seeing it:
 *  - **a ceiling sized in bytes.** 6 GB of headroom is 53 seconds on a gigabit
 *    line and 13 hours on a megabit one. A horizon in bytes serves one of them
 *    for a whole bulk interval past what they paid for, and the panel is the
 *    only thing that notices;
 *  - **a rate read off the last sample while it is still climbing.** A user
 *    ramping from 10 Mbit to a gigabit is sized at 10 Mbit, and the block is
 *    spent before the interval that bought it is over;
 *  - **a first block sized at a rate nobody has measured yet.** There is no
 *    sample on a config's first pass, and treating that as idle is a user who
 *    stalls on their first download;
 *  - **a ledger row per second.** Every block is a `traffic_consumption` row
 *    (`contract.traffic-block.md`), and a horizon with no floor under it buys
 *    one per pass for as long as the user is hot.
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { BlockPurchaseRefused } from './block-purchase';

import {
  HORIZON_SECONDS,
  MAX_INTERVAL_MS,
  MIN_BLOCK_SECONDS,
  MIN_INTERVAL_MS,
  HotLoopService,
  measureRateBps,
  nextIntervalMs,
  projectRateBps,
  sizeHorizon,
  timeToCeilingSeconds,
} from './horizon';

const GB = BigInt(1) << BigInt(30);
const GIGABIT = BigInt(1_000_000_000);
const MEGABIT = BigInt(1_000_000);
const GRANT = '77777777-7777-4777-8777-777777777777';
/** bytes one second of `bps` carries. */
const secondsOf = (bps: bigint, seconds: number) => (bps / BigInt(8)) * BigInt(seconds);

describe('timeToCeilingSeconds', () => {
  it('reads the same headroom as a minute on one line and half a day on another', () => {
    expect(timeToCeilingSeconds(BigInt(6) * GB, GIGABIT)).toBeCloseTo(51.5, 0);
    expect(timeToCeilingSeconds(BigInt(6) * GB, MEGABIT)).toBeGreaterThan(12 * 3600);
  });

  it('is zero for a spent allowance at any speed, and unknown with no rate', () => {
    expect(timeToCeilingSeconds(BigInt(0), GIGABIT)).toBe(0);
    expect(timeToCeilingSeconds(-GB, GIGABIT)).toBe(0);
    expect(timeToCeilingSeconds(BigInt(6) * GB, BigInt(0))).toBeNull();
  });
});

describe('projectRateBps — the rising ramp', () => {
  it('extrapolates one more step of a rate that is still climbing', () => {
    // 10 Mbit, then 100: the next interval is sized at 190, not 100.
    expect(projectRateBps(BigInt(100) * MEGABIT, BigInt(10) * MEGABIT)).toBe(BigInt(190) * MEGABIT);
  });

  it('never extrapolates a falling rate downwards', () => {
    // Sizing below what is being measured right now buys a block the user has
    // already outrun. A fall is taken at face value and no further.
    expect(projectRateBps(BigInt(10) * MEGABIT, BigInt(100) * MEGABIT)).toBe(BigInt(10) * MEGABIT);
  });

  it('has nothing to extrapolate from on the first measurement', () => {
    expect(projectRateBps(BigInt(50) * MEGABIT, null)).toBe(BigInt(50) * MEGABIT);
  });
});

describe('measureRateBps', () => {
  it('is the bytes between two samples over the seconds between them', () => {
    const rate = measureRateBps({ atMs: 0, servedBytes: BigInt(0) }, { atMs: 10_000, servedBytes: secondsOf(GIGABIT, 10) });
    expect(rate).toBe(GIGABIT);
  });

  it('has no rate from one sample, from no time passing, or from a clock that went back', () => {
    expect(measureRateBps(undefined, { atMs: 10_000, servedBytes: GB })).toBeNull();
    expect(measureRateBps({ atMs: 10_000, servedBytes: BigInt(0) }, { atMs: 10_000, servedBytes: GB })).toBeNull();
    expect(measureRateBps({ atMs: 20_000, servedBytes: BigInt(0) }, { atMs: 10_000, servedBytes: GB })).toBeNull();
  });

  it('reads a counter that went backward as no rate rather than a negative one', () => {
    expect(measureRateBps({ atMs: 0, servedBytes: BigInt(5) * GB }, { atMs: 1000, servedBytes: GB })).toBe(BigInt(0));
  });
});

describe('sizeHorizon', () => {
  const base = { previousRateBps: null, lineRateBps: null };

  it('buys nothing for a config that cannot empty its allowance inside the horizon', () => {
    const horizon = sizeHorizon({ ...base, headroomBytes: BigInt(6) * GB, rateBps: MEGABIT });
    expect(horizon.targetBytes).toBe(BigInt(0));
    expect(horizon.hot).toBe(false);
  });

  it('tops a hot config up to a horizon of its own measured rate', () => {
    const headroomBytes = secondsOf(GIGABIT, 30);
    const horizon = sizeHorizon({ ...base, headroomBytes, rateBps: GIGABIT });

    expect(horizon.hot).toBe(true);
    expect(horizon.rateBps).toBe(GIGABIT);
    // 120 seconds of headroom, less the 30 it already has.
    expect(horizon.targetBytes).toBe(secondsOf(GIGABIT, HORIZON_SECONDS - 30));
  });

  it('sizes the first block at the panel line rate when nothing has been measured', () => {
    const horizon = sizeHorizon({ headroomBytes: BigInt(0), rateBps: null, previousRateBps: null, lineRateBps: GIGABIT });

    expect(horizon.hot).toBe(true);
    expect(horizon.rateBps).toBe(GIGABIT);
    expect(horizon.targetBytes).toBe(secondsOf(GIGABIT, HORIZON_SECONDS));
  });

  it('buys nothing where neither a measured rate nor a declared line rate exists', () => {
    // Zero is unknown, not zero — the same reading the plausibility cap gives
    // `panel.maxLineRateBps`. Guessing a rate here spends a wallet on a number
    // nobody measured.
    const horizon = sizeHorizon({ headroomBytes: BigInt(6) * GB, rateBps: null, previousRateBps: null, lineRateBps: null });
    expect(horizon.targetBytes).toBe(BigInt(0));
    expect(horizon.timeToCeilingSeconds).toBeNull();
  });

  it('sizes the horizon past the last sample while the rate is still climbing', () => {
    const headroomBytes = secondsOf(BigInt(100) * MEGABIT, 10);
    const horizon = sizeHorizon({ headroomBytes, rateBps: BigInt(100) * MEGABIT, previousRateBps: BigInt(10) * MEGABIT, lineRateBps: null });

    expect(horizon.rateBps).toBe(BigInt(190) * MEGABIT);
    expect(horizon.targetBytes).toBeGreaterThan(secondsOf(BigInt(100) * MEGABIT, HORIZON_SECONDS - 10));
  });

  it('raises a block under the floor up to it, so the ledger gets one row a minute at most', () => {
    // A hairsbreadth inside the horizon: the deficit is seconds of traffic,
    // and buying it would put a `traffic_consumption` row in the wallet on
    // every pass for as long as the user stays hot
    // (`contract.traffic-block.md`, F-027-am).
    const headroomBytes = secondsOf(GIGABIT, HORIZON_SECONDS - 1);
    const horizon = sizeHorizon({ ...base, headroomBytes, rateBps: GIGABIT });

    expect(horizon.targetBytes).toBe(secondsOf(GIGABIT, MIN_BLOCK_SECONDS));
    expect(horizon.flooredToMinimumBlock).toBe(true);
  });
});

describe('nextIntervalMs', () => {
  it('is a quarter of the nearest ceiling, not the average', () => {
    expect(nextIntervalMs([120, 20])).toBe(5_000);
  });

  it('clamps at two seconds below and the bulk interval above', () => {
    expect(nextIntervalMs([0])).toBe(MIN_INTERVAL_MS);
    expect(nextIntervalMs([4])).toBe(MIN_INTERVAL_MS);
    expect(nextIntervalMs([])).toBe(MAX_INTERVAL_MS);
    expect(nextIntervalMs([null, null])).toBe(MAX_INTERVAL_MS);
  });
});

// ---- the transaction -------------------------------------------------------

type ConfigRow = { id: string; observedRateBps: bigint | null; served: bigint; panelRateBps: bigint | null };

function fakeTx(input: { purchasedBytes: bigint; consumedBytes: bigint; configs: ConfigRow[]; balance?: string }) {
  const writes: { id: string; observedRateBps: bigint | null }[] = [];
  const suspensions: Record<string, unknown>[] = [];
  const tx = {
    grant: {
      findUnique: async () =>
        input.purchasedBytes < BigInt(0)
          ? null
          : {
              id: GRANT,
              userId: 'u',
              status: GrantStatus.active,
              billingMode: VariantBillingMode.metered,
              meteredRate: new Prisma.Decimal('0.5'),
              purchasedBytes: input.purchasedBytes,
              consumedBytes: input.consumedBytes,
            },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        suspensions.push(data);
        return { count: 1 };
      },
    },
    $queryRaw: async () => [{ cachedBalance: new Prisma.Decimal(input.balance ?? '0.00') }],
    config: {
      findMany: async () =>
        input.configs.map((c) => ({
          id: c.id,
          observedRateBps: c.observedRateBps,
          counterState: { lifetimeUpBytes: c.served, lifetimeDownBytes: BigInt(0) },
          panel: { maxLineRateBps: c.panelRateBps },
        })),
      update: async ({ where, data }: { where: { id: string }; data: { observedRateBps: bigint | null } }) => {
        writes.push({ id: where.id, observedRateBps: data.observedRateBps });
      },
      updateMany: async () => ({ count: input.configs.length }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, writes, suspensions };
}

const config = (id: string, served: bigint, observedRateBps: bigint | null = null, panelRateBps: bigint | null = GIGABIT): ConfigRow => ({
  id,
  served,
  observedRateBps,
  panelRateBps,
});

function service(refuse?: BlockPurchaseRefused) {
  const purchases: { grantId: string; targetBytes: bigint }[] = [];
  const rebalances: { grantId: string; hotConfigId?: string | null }[] = [];
  const blocks = {
    purchase: async (_tx: unknown, input: { grantId: string; targetBytes: bigint }) => {
      purchases.push(input);
      if (refuse) throw refuse;
      return { grantId: input.grantId, bytes: input.targetBytes, amount: new Prisma.Decimal(1), walletTransactionId: 'w', purchasedBytes: BigInt(0), billedBytes: BigInt(0) };
    },
  };
  const ceilings = {
    rebalance: async (_tx: unknown, input: { grantId: string; hotConfigId?: string | null }) => {
      rebalances.push(input);
      return { grantId: input.grantId, ceilings: [], unallocatedBytes: BigInt(0), written: 1 };
    },
  };
  return { hot: new HotLoopService({} as never, blocks as never, ceilings as never), purchases, rebalances };
}

describe('HotLoopService.topUpIn', () => {
  it('buys the next block and rebalances it in one transaction', async () => {
    const { tx } = fakeTx({
      purchasedBytes: secondsOf(GIGABIT, 30),
      consumedBytes: BigInt(0),
      configs: [config('hot', BigInt(0), GIGABIT)],
    });
    const { hot, purchases, rebalances } = service();

    const outcome = await hot.topUpIn(tx, { grantId: GRANT, atMs: 1_000 });

    expect(outcome.bought?.bytes).toBe(secondsOf(GIGABIT, HORIZON_SECONDS - 30));
    expect(purchases).toHaveLength(1);
    expect(rebalances).toEqual([{ grantId: GRANT, hotConfigId: 'hot' }]);
  });

  it('names the fastest config as the hot one, so the bag concentrates where it is being spent', async () => {
    const { tx } = fakeTx({
      purchasedBytes: secondsOf(GIGABIT, 10),
      consumedBytes: BigInt(0),
      configs: [config('idle', BigInt(0), MEGABIT), config('busy', BigInt(0), BigInt(500) * MEGABIT)],
    });
    const { hot, rebalances } = service();

    await hot.topUpIn(tx, { grantId: GRANT, atMs: 1_000 });

    expect(rebalances[0]?.hotConfigId).toBe('busy');
  });

  it('measures each config rate from the last pass and writes it back', async () => {
    const rows = [config('a', BigInt(0), null)];
    const first = fakeTx({ purchasedBytes: BigInt(0), consumedBytes: BigInt(0), configs: rows });
    const { hot } = service();

    await hot.topUpIn(first.tx, { grantId: GRANT, atMs: 0 });
    // Ten seconds later the config has carried ten seconds of a gigabit.
    const second = fakeTx({ purchasedBytes: BigInt(0), consumedBytes: BigInt(0), configs: [config('a', secondsOf(GIGABIT, 10), null)] });
    await hot.topUpIn(second.tx, { grantId: GRANT, atMs: 10_000 });

    expect(second.writes).toEqual([{ id: 'a', observedRateBps: GIGABIT }]);
  });

  it('buys nothing and rebalances nothing for a Grant that is not near its ceiling', async () => {
    const { tx } = fakeTx({
      purchasedBytes: BigInt(100) * GB,
      consumedBytes: BigInt(0),
      configs: [config('a', BigInt(0), MEGABIT)],
    });
    const { hot, purchases, rebalances } = service();

    const outcome = await hot.topUpIn(tx, { grantId: GRANT, atMs: 1_000 });

    expect(outcome.bought).toBeNull();
    expect(purchases).toHaveLength(0);
    expect(rebalances).toHaveLength(0);
  });

  it('suspends a Grant the panel has already stopped: bag spent, no rate, wallet empty (F-027-x)', async () => {
    const { tx, suspensions } = fakeTx({
      purchasedBytes: GB,
      consumedBytes: GB,
      // Measured idle, on a panel that declares no line rate: nothing to size a block from.
      configs: [config('a', GB, BigInt(0), null)],
    });
    const { hot, purchases } = service();

    const outcome = await hot.topUpIn(tx, { grantId: GRANT, atMs: 1_000 });

    expect(purchases).toHaveLength(0);
    expect(outcome.exhausted).toEqual({ grantId: GRANT, verdict: 'suspended', configsDisabled: 1 });
    expect(suspensions).toEqual([{ status: GrantStatus.suspended, statusReason: 'quota_exhausted', suspendedAt: new Date(1_000) }]);
  });

  it('suspends, rather than throws, when the bag is spent and the purchase is refused for money', async () => {
    const { tx } = fakeTx({ purchasedBytes: GB, consumedBytes: GB, configs: [config('a', GB, GIGABIT)] });
    const { hot, rebalances } = service(new BlockPurchaseRefused('insufficient_funds', '0.00'));

    const outcome = await hot.topUpIn(tx, { grantId: GRANT, atMs: 1_000 });

    expect(outcome.exhausted?.verdict).toBe('suspended');
    expect(outcome.bought).toBeNull();
    expect(rebalances).toHaveLength(0);
  });

  it('keeps the refusal while the bag still holds bytes — a short wallet is not yet an empty bag', async () => {
    const { tx, suspensions } = fakeTx({ purchasedBytes: secondsOf(GIGABIT, 30), consumedBytes: BigInt(0), configs: [config('a', BigInt(0), GIGABIT)] });
    const { hot } = service(new BlockPurchaseRefused('insufficient_funds', '0.00'));

    await expect(hot.topUpIn(tx, { grantId: GRANT, atMs: 1_000 })).rejects.toMatchObject({ reason: 'insufficient_funds' });
    expect(suspensions).toHaveLength(0);
  });

  it('never asks about exhaustion on a pass that bought a block', async () => {
    const { tx, suspensions } = fakeTx({ purchasedBytes: GB, consumedBytes: GB, configs: [config('a', GB, GIGABIT)], balance: '5.00' });
    const { hot } = service();

    const outcome = await hot.topUpIn(tx, { grantId: GRANT, atMs: 1_000 });

    expect(outcome.bought).not.toBeNull();
    expect(outcome.exhausted).toBeNull();
    expect(suspensions).toHaveLength(0);
  });

  it('answers a missing Grant as a refusal, not a crash', async () => {
    const { tx } = fakeTx({ purchasedBytes: BigInt(-1), consumedBytes: BigInt(0), configs: [] });
    const { hot } = service();

    await expect(hot.topUpIn(tx, { grantId: 'other', atMs: 0 })).rejects.toMatchObject({ reason: 'grant_not_found' });
  });
});
