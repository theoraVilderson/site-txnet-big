import { Injectable } from '@nestjs/common';
import { ConfigStatus, Prisma } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { BlockPurchaseService, type PurchasedBlock } from './block-purchase';
import { CeilingAllocatorService, type RebalancedGrant } from './ceiling-allocator';

/**
 * The hot loop's horizon — how much to buy next, and when (F-027-u, ADR-0072).
 *
 * **A ceiling is sized in seconds, not bytes.** Six gigabytes of headroom is
 * fifty-one seconds on a gigabit line and thirteen hours on a megabit one, and
 * no single byte figure can be right for both. Sizing in seconds is what makes
 * every line speed safe: a faster user gets a bigger block at the same
 * interval rather than a shorter grace period at the same block.
 *
 * This is the money half of the hot loop. The other half is the collector's
 * (`network-service/internal/hot`), which decides *which* configs to re-read
 * and how often on exactly the same figure — time to ceiling — so that the
 * rate this half sizes a block from is a fresh one. Both are described in
 * `docs/domains/network/contract.hot-loop.md`.
 *
 * It buys and splits in **one** transaction: `BlockPurchaseService.purchase`
 * and `CeilingAllocatorService.rebalance` on the caller's `tx`, so there is no
 * window where `purchasedBytes` has advanced and no ceiling covers it, nor one
 * where a ceiling was written against money that failed to leave the wallet.
 */

/**
 * The headroom a purchase tops a Grant up to, in seconds of the rate it is
 * running at. It is also the membership line: a Grant that cannot exhaust its
 * allowance inside one horizon is not hot, and the bulk pass keeps it.
 *
 * Two minutes is the figure `contract.traffic-block.md` costs the wallet
 * ledger at — "hundreds of rows a day for a heavy user" — and shortening it
 * buys less of the wallet ahead of consumption at the price of more rows.
 */
export const HORIZON_SECONDS = 120;

/**
 * The block floor, in seconds of the same rate (F-027-am).
 *
 * Every block is a `traffic_consumption` row, and a horizon with no floor
 * under it buys one on every pass: a Grant a second inside the horizon would
 * buy one second of traffic, over and over, for as long as the user stays
 * hot. Flooring the **target** — never the horizon — bounds that at one row a
 * minute per Grant, whatever the line speed, because a faster user's minute is
 * a bigger block rather than a more frequent one.
 *
 * The floor is here and not in `BlockPurchaseService` because this is the one
 * place that knows the user's rate; `purchase()` never clamps a target up
 * (`contract.traffic-block.md`).
 */
export const MIN_BLOCK_SECONDS = 60;

/** The fastest the hot loop may run. Below this it is a request rate on somebody else's server (F-027-v). */
export const MIN_INTERVAL_MS = 2_000;
/** The slowest. It is the bulk pass's own interval: slower than that is not a hot loop. */
export const MAX_INTERVAL_MS = 60_000;
/** The nearest time-to-ceiling is quartered, so no member spends more than about a quarter of what it has left unseen. */
export const INTERVAL_DIVISOR = 4;

const BITS_PER_BYTE = BigInt(8);
const MS = BigInt(1000);

/** One reading of how much a config has served, and when. */
export type RateSample = { atMs: number; servedBytes: bigint };

/**
 * The rate between two samples, in bits per second.
 *
 * `null` is **not measurable** — one sample, no time between two, or a clock
 * that went back — and it is not the same answer as zero, which is a config
 * that is measurably idle. The caller falls back to the panel's line rate on
 * the first and treats the second as a Grant that is not being spent.
 *
 * A counter that went backward reads as no traffic rather than a negative
 * rate: the same rule the normaliser holds, for the same reason (ADR-0074).
 */
export function measureRateBps(previous: RateSample | undefined, current: RateSample): bigint | null {
  if (!previous) return null;
  const elapsedMs = current.atMs - previous.atMs;
  if (elapsedMs <= 0) return null;
  const served = current.servedBytes - previous.servedBytes;
  if (served <= BigInt(0)) return BigInt(0);
  return (served * BITS_PER_BYTE * MS) / BigInt(elapsedMs);
}

/**
 * The rising ramp: a rate still climbing is extrapolated one more step.
 *
 * A user who went from 10 Mbit to 100 between two samples is not a 100 Mbit
 * user — they are somewhere on their way up, and a block sized at 100 is spent
 * before the interval that bought it is over. One step of the same climb is
 * the cheapest correction that is still measured rather than guessed.
 *
 * A **falling** rate is taken at face value and never extrapolated downwards.
 * Sizing below what is being measured right now buys a block the user has
 * already outrun, and the failure it causes is a stall — which ADR-0072
 * accepts as the worst outcome, not as a routine one.
 */
export function projectRateBps(rateBps: bigint, previousRateBps: bigint | null): bigint {
  if (previousRateBps === null || rateBps <= previousRateBps) return rateBps;
  return rateBps + (rateBps - previousRateBps);
}

/**
 * How long this allowance lasts at this rate. Zero for a spent allowance at
 * any speed; `null` where there is no rate to judge it at, which is unknown
 * rather than "about to run out".
 */
export function timeToCeilingSeconds(headroomBytes: bigint, rateBps: bigint): number | null {
  if (headroomBytes <= BigInt(0)) return 0;
  if (rateBps <= BigInt(0)) return null;
  return (Number(headroomBytes) * 8) / Number(rateBps);
}

/**
 * The gap before the next hot pass: a quarter of the **nearest** time to
 * ceiling, clamped. The nearest and not the average, because the loop runs for
 * whoever is closest to their ceiling and the rest are read early rather than
 * late. Nobody hot falls back to the bulk interval.
 */
export function nextIntervalMs(timesToCeilingSeconds: (number | null)[]): number {
  const known = timesToCeilingSeconds.filter((seconds): seconds is number => seconds !== null);
  if (known.length === 0) return MAX_INTERVAL_MS;
  const next = (Math.min(...known) * 1000) / INTERVAL_DIVISOR;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(next)));
}

export type HorizonInput = {
  /** What is left of the bag: `purchasedBytes - consumedBytes`. Zero or below is a spent allowance. */
  headroomBytes: bigint;
  /** The measured rate in bits per second, or null where nothing has measured one yet. */
  rateBps: bigint | null;
  /** The rate measured before it, for the rising ramp. */
  previousRateBps: bigint | null;
  /**
   * `panel.maxLineRateBps` — the rate a config that has never been measured is
   * judged at. Zero and null are **unknown**, not zero, exactly as the
   * plausibility cap reads the same column (`contract.collection.md`).
   */
  lineRateBps: bigint | null;
};

export type Horizon = {
  /** The rate the horizon was sized at: the projection, or the line rate on a first pass. */
  rateBps: bigint;
  timeToCeilingSeconds: number | null;
  /** Whether this Grant is inside the horizon and therefore the hot loop's. */
  hot: boolean;
  /** What to ask `BlockPurchaseService` to cover. Zero is nothing to buy. */
  targetBytes: bigint;
  /** The target was the floor rather than the deficit — the ledger write rate being bounded. */
  flooredToMinimumBlock: boolean;
};

const bytesPerSecond = (rateBps: bigint) => rateBps / BITS_PER_BYTE;

/**
 * Sizes the next block, or declines to.
 *
 * A Grant is hot when what is left of its bag would be gone inside one
 * horizon. A hot Grant is topped back up to a full horizon of its projected
 * rate; the target is the deficit, raised to the block floor so that a Grant
 * hovering at the edge of the horizon does not buy a ledger row per pass.
 *
 * Nothing is bought where there is no rate at all — never measured, on a panel
 * that declares no line rate. Guessing one would spend a wallet against a
 * figure nobody measured, and the config is already covered by whatever
 * ceiling it holds and by the panel enforcing it.
 */
export function sizeHorizon(input: HorizonInput): Horizon {
  const measured = input.rateBps !== null && input.rateBps > BigInt(0) ? projectRateBps(input.rateBps, input.previousRateBps) : null;
  const rateBps = measured ?? (input.lineRateBps !== null && input.lineRateBps > BigInt(0) ? input.lineRateBps : BigInt(0));
  const none: Horizon = { rateBps, timeToCeilingSeconds: null, hot: false, targetBytes: BigInt(0), flooredToMinimumBlock: false };
  if (rateBps <= BigInt(0)) return none;

  const seconds = timeToCeilingSeconds(input.headroomBytes, rateBps);
  if (seconds === null || seconds > HORIZON_SECONDS) return { ...none, timeToCeilingSeconds: seconds };

  const perSecond = bytesPerSecond(rateBps);
  const headroom = input.headroomBytes > BigInt(0) ? input.headroomBytes : BigInt(0);
  const deficit = perSecond * BigInt(HORIZON_SECONDS) - headroom;
  const floor = perSecond * BigInt(MIN_BLOCK_SECONDS);
  const targetBytes = deficit > floor ? deficit : floor;

  return { rateBps, timeToCeilingSeconds: seconds, hot: true, targetBytes, flooredToMinimumBlock: targetBytes === floor && deficit < floor };
}

/** Why nothing was bought. Nothing was written. */
export type HotLoopRejection = 'grant_not_found';

export class HotLoopRefused extends Error {
  constructor(
    readonly reason: HotLoopRejection,
    detail = '',
  ) {
    super(`hot loop refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'HotLoopRefused';
  }
}

export type TopUp = {
  grantId: string;
  /** The pass's own clock, as the collection pass's is: one reading bounds one pass. */
  atMs?: number;
};

export type TopUpOutcome = Horizon & {
  grantId: string;
  /** The config the bag was concentrated on — the fastest one, or null where none is measurably running. */
  hotConfigId: string | null;
  /** Null where nothing was bought: the Grant is not near its ceiling, or has no rate to size a block from. */
  bought: PurchasedBlock | null;
  rebalanced: RebalancedGrant | null;
};

@Injectable()
export class HotLoopService {
  /**
   * The previous pass's samples, per config, and the previous projected rate
   * per Grant. Both are in memory because both are *this loop's* view of a
   * rate it measured seconds ago: a rate read back out of a column would be
   * whatever the last process to run wrote, at whatever interval it ran at.
   * What is durable is `config.observedRateBps`, written below, which is what
   * the collector's half of the loop reads (`contract.hot-loop.md`).
   */
  private readonly lastSample = new Map<string, RateSample>();
  private readonly lastRate = new Map<string, bigint>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly blocks: BlockPurchaseService,
    private readonly ceilings: CeilingAllocatorService,
  ) {}

  /** One top-up in a transaction of its own, for a caller with no other work to commit with it. */
  topUp(input: TopUp): Promise<TopUpOutcome> {
    return tenantTransaction(this.prisma, (tx) => this.topUpIn(tx, input));
  }

  /**
   * Measures the Grant's rate, sizes the next block from it, and buys and
   * splits it in the caller's transaction.
   *
   * The per-config rates are measured here rather than read off a column,
   * because the interval between two of this loop's passes is the only window
   * a rate means anything over. What is written back is
   * `config.observedRateBps`, for the collector's half of the loop and for the
   * panel that shows it.
   */
  async topUpIn(tx: Prisma.TransactionClient, input: TopUp): Promise<TopUpOutcome> {
    const atMs = input.atMs ?? Date.now();
    const grant = await tx.grant.findUnique({
      where: { id: input.grantId },
      select: { id: true, purchasedBytes: true, consumedBytes: true },
    });
    if (!grant) throw new HotLoopRefused('grant_not_found', input.grantId);

    const configs = await tx.config.findMany({
      where: { grantId: grant.id, status: ConfigStatus.active, desiredEnabled: true },
      select: {
        id: true,
        observedRateBps: true,
        counterState: { select: { lifetimeUpBytes: true, lifetimeDownBytes: true } },
        panel: { select: { maxLineRateBps: true } },
      },
    });

    let grantRateBps: bigint | null = null;
    let hotConfigId: string | null = null;
    let hotRateBps = BigInt(0);
    let lineRateBps: bigint | null = null;

    for (const config of configs) {
      const served = config.counterState
        ? config.counterState.lifetimeUpBytes + config.counterState.lifetimeDownBytes
        : BigInt(0);
      const measured = measureRateBps(this.lastSample.get(config.id), { atMs, servedBytes: served });
      this.lastSample.set(config.id, { atMs, servedBytes: served });

      // A pass that could not measure keeps whatever the column already holds
      // — the last pass's figure, or nothing at all on a config's first sight.
      const rateBps = measured ?? config.observedRateBps;
      if (measured !== null && measured !== config.observedRateBps) {
        await tx.config.update({ where: { id: config.id }, data: { observedRateBps: measured } });
      }

      if (rateBps !== null && rateBps > BigInt(0)) {
        grantRateBps = (grantRateBps ?? BigInt(0)) + rateBps;
        if (rateBps > hotRateBps) {
          // The bag concentrates on the config actually consuming it
          // (`contract.ceiling.md`); the others keep their floor.
          hotRateBps = rateBps;
          hotConfigId = config.id;
        }
      }
      const panelRate = config.panel.maxLineRateBps;
      if (panelRate !== null && (lineRateBps === null || panelRate > lineRateBps)) lineRateBps = panelRate;
    }

    const horizon = sizeHorizon({
      headroomBytes: grant.purchasedBytes - grant.consumedBytes,
      rateBps: grantRateBps,
      previousRateBps: this.lastRate.get(grant.id) ?? null,
      lineRateBps,
    });
    if (grantRateBps !== null) this.lastRate.set(grant.id, grantRateBps);

    if (!horizon.hot || horizon.targetBytes <= BigInt(0)) {
      return { ...horizon, grantId: grant.id, hotConfigId, bought: null, rebalanced: null };
    }

    // One transaction, both halves. A purchase committed without the
    // rebalance that spends it is bytes bought and no ceiling covering them;
    // a rebalance committed without the purchase is a ceiling over money that
    // never left the wallet.
    const bought = await this.blocks.purchase(tx, { grantId: grant.id, targetBytes: horizon.targetBytes });
    const rebalanced = await this.ceilings.rebalance(tx, { grantId: grant.id, hotConfigId });

    return { ...horizon, grantId: grant.id, hotConfigId, bought, rebalanced };
  }
}
