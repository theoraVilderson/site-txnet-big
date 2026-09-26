import { Injectable } from '@nestjs/common';
import { ConfigStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { bytesAffordable } from './block-purchase';

/**
 * The ceiling allocator (F-027-s; ADR-0072 rule 1).
 *
 * **`Σ ceilings ≤ purchasedBytes`, across every config of a Grant, always.**
 * One bag spread over five panels needs one ceiling split five ways, not five
 * full ceilings — five would serve `5 x purchasedBytes` against one purchase,
 * and each one would look correct on the panel it sits on. That is the hole
 * ADR-0072 closes, so the split is an invariant with a property test
 * (`ceiling-allocator.spec.ts`, entitlement invariant 8) and not a tuning.
 *
 * It decides; it never buys. `BlockPurchaseService` advances `purchasedBytes`
 * and this hands out what that bought — the bound and the split move in one
 * direction only, so a bug here can strand bytes but cannot invent them. The
 * horizon that decides *how much* to buy is F-027-u's, and it calls the
 * purchase and this rebalance in one transaction.
 *
 * It writes `allocatedCeilingBytes`, and beside it `walletBackedCeilingBytes`
 * — the same split over the wallet too, which a graceful shutdown raises the
 * panel to (F-027-w, ADR-0078). Getting either number onto the panel —
 * `SetClientDataLimit`, `appliedCeilingBytes`, and the rewrite in the pass
 * that detects a counter reset — is `network-service`'s, never this.
 */

/**
 * The unit of account is **lifetime bytes for that config**: what the config
 * has carried since it existed, across panel resets
 * (`ConfigCounterState.lifetime*`), which is the basis `purchasedBytes` is
 * counted on. The panel's own counter is not: it starts at zero after a
 * restore, and translating a lifetime allowance into the figure that panel's
 * counter needs today is F-027-t's job, in the pass that sees the reset.
 */
export type ConfigDemand = {
  configId: string;
  /** Lifetime bytes already served on this config. A ceiling is never lowered under it. */
  servedBytes: bigint;
  /** `billing.SubAccount.dataCapBytes` (F-608), or null where the config carries no active sub-account. */
  capBytes: bigint | null;
  /**
   * `panel.maxLineRateBps` of the config's panel, in bits per second: how fast
   * an idle config can drain its floor (ADR-0091). Zero and null are unknown.
   */
  lineRateBps?: bigint | null;
};

export type AllocationInput = {
  /** The bag: what this Grant has bought and not given back. The bound on the whole allocation. */
  purchasedBytes: bigint;
  /**
   * Headroom every config keeps above what it has served, before the hot one
   * takes the rest. With `floorSeconds`, the least of it.
   */
  floorBytes: bigint;
  /**
   * The floor in seconds of each config's line (ADR-0091): `lineRateBps / 8 ×
   * floorSeconds`, at least `floorBytes`, at most an even share of what pass 1
   * left — of half of it, among the idle ones, when a hot config is named
   * (F-027-cr); that share where the line rate is unknown. Absent is
   * `floorBytes` flat, the floor before ADR-0091.
   */
  floorSeconds?: number;
  /** The config the hot loop says is consuming (F-027-u). It is first in line for everything. */
  hotConfigId?: string | null;
  configs: ConfigDemand[];
};

export type ConfigCeiling = {
  configId: string;
  ceilingBytes: bigint;
  /** The sub-account was the smaller authority here — the share was cut to its cap. */
  cappedBySubAccount: boolean;
};

export type Allocation = {
  ceilings: ConfigCeiling[];
  /** Bought, and no config can carry it: every one of them is capped. F-027-u's signal to stop buying. */
  unallocatedBytes: bigint;
};

/**
 * 100 MiB — the headroom a config keeps while another one is hot, so a user's
 * phone still connects while their desktop runs. It is a floor on the *share*,
 * never on the purchase: buying is sized by the horizon (F-027-u), and this
 * hands out only what is already bought.
 */
export const DEFAULT_CONFIG_FLOOR_BYTES = BigInt(100 * 1024 * 1024);

/**
 * How long an idle config's floor lasts at its panel's line rate (ADR-0091):
 * the bulk pass's interval (`collect.DefaultInterval`, 60s, network-service)
 * — the longest a config that starts drawing goes unseen — plus the hot loop's
 * horizon (`HORIZON_SECONDS`, 120s), inside which the next rebalance hands it
 * the bag. Under it, a user switching inbounds at line rate is cut off before
 * anything can move bytes to them.
 */
export const IDLE_FLOOR_SECONDS = 180;

/** Why nothing was allocated. Nothing was written. */
export type CeilingAllocationRejection = 'grant_not_found';

export class CeilingAllocationRefused extends Error {
  constructor(
    readonly reason: CeilingAllocationRejection,
    detail = '',
  ) {
    super(`ceiling allocation refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'CeilingAllocationRefused';
  }
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** A config's own hard ceiling: its sub-account cap, or nothing but the bag. */
const capOf = (config: ConfigDemand, bag: bigint) => (config.capBytes === null ? bag : min(config.capBytes, bag));

/**
 * Splits `purchasedBytes` across a Grant's configs.
 *
 * Three passes over the configs, in one order — the hot config first, then the
 * heaviest, then by id so the result is decided by the input alone:
 *
 * 1. **what it has already served.** A ceiling under that is a byte carried
 *    with no ceiling covering it, which is the guarantee failing after the
 *    fact rather than a byte saved.
 * 2. **the floor above it**, so no config is starved to zero headroom while
 *    another one runs — seconds of its own line (ADR-0091), so a user who
 *    switches inbounds at full speed is not cut off before the loop reacts.
 * 3. **everything left**, to the hot config first. That is the concentration:
 *    the config actually consuming gets the bag, and the others keep a floor.
 *
 * Each pass hands out what is left and no more, so `Σ ceilings ≤ purchasedBytes`
 * holds by construction rather than by a check at the end. A bag too small for
 * pass 1 is an overrun the holds queue settles (ADR-0074): the ceilings stop at
 * the bag, in the order above, and the panels cut the rest off themselves.
 *
 * `min(share, sub-account cap)` is applied inside every pass, not over the
 * result — the smaller cap wins (F-608), and the bytes it refuses stay in the
 * bag for the next config rather than being stranded on a config that cannot
 * carry them.
 */
export function allocateCeilings(input: AllocationInput): Allocation {
  const bag = input.purchasedBytes > BigInt(0) ? input.purchasedBytes : BigInt(0);
  const floorBytes = input.floorBytes > BigInt(0) ? input.floorBytes : BigInt(0);

  const order = [...input.configs].sort((a, b) => {
    if (a.configId === input.hotConfigId) return -1;
    if (b.configId === input.hotConfigId) return 1;
    if (a.servedBytes !== b.servedBytes) return a.servedBytes > b.servedBytes ? -1 : 1;
    return a.configId < b.configId ? -1 : 1;
  });

  const given = new Map(order.map((config) => [config.configId, BigInt(0)]));
  let remaining = bag;

  /** One pass: raise each config towards `target`, out of what is left. */
  const pass = (target: (config: ConfigDemand) => bigint) => {
    for (const config of order) {
      const held = given.get(config.configId) as bigint;
      const want = min(target(config), capOf(config, bag)) - held;
      if (want <= BigInt(0)) continue;
      const grant = min(want, remaining);
      given.set(config.configId, held + grant);
      remaining -= grant;
    }
  };

  pass((config) => config.servedBytes);
  const floorOf = floors(input, floorBytes, remaining);
  pass((config) => config.servedBytes + floorOf(config));
  pass(() => bag);

  return {
    // In the order they were decided in, hot config first: the same input
    // gives the same allocation, row for row, whatever order the rows arrived.
    ceilings: order.map((config) => {
      const ceilingBytes = given.get(config.configId) as bigint;
      return { configId: config.configId, ceilingBytes, cappedBySubAccount: config.capBytes !== null && ceilingBytes === config.capBytes };
    }),
    unallocatedBytes: remaining,
  };
}

/**
 * Pass 2's headroom per config. Sized from what pass 1 left, so the floors
 * together never exceed it and pass 2 always fits: the split stays monotone in
 * the bag, which the shutdown figure rests on (F-027-w).
 */
function floors(input: AllocationInput, floorBytes: bigint, left: bigint): (config: ConfigDemand) => bigint {
  if (input.floorSeconds === undefined) return () => floorBytes;
  const even = shareOf(input, left);
  const seconds = BigInt(Math.max(0, Math.floor(input.floorSeconds)));
  return (config) => {
    // Pass 3 hands the hot config everything left, so its floor adds nothing.
    if (config.configId === input.hotConfigId) return BigInt(0);
    const rate = config.lineRateBps;
    if (rate === null || rate === undefined || rate <= BigInt(0)) return even;
    const line = (rate / BigInt(8)) * seconds;
    return min(even, line > floorBytes ? line : floorBytes);
  };
}

/**
 * The most one config's floor may take. On a bulk pass, an even share of what
 * pass 1 left. With a hot config named, the idle ones share **half** of it
 * (F-027-cr, ADR-0091 amendment): an even share over N configs gave the one
 * actually consuming 1/N per re-split — a fifth at five gigabit inbounds — and
 * a fast user near the end of a bag was re-split and cut inside the guard band
 * (F-027-co) over and over. Half converges in a handful of re-splits whatever N.
 */
function shareOf(input: AllocationInput, left: bigint): bigint {
  const count = input.configs.length;
  if (count === 0) return BigInt(0);
  const hot = input.hotConfigId != null && input.configs.some((config) => config.configId === input.hotConfigId);
  if (!hot) return left / BigInt(count);
  return count > 1 ? left / BigInt(2) / BigInt(count - 1) : BigInt(0);
}

export type RebalanceGrant = {
  grantId: string;
  /** The config the hot loop says is consuming (F-027-u); null on a bulk pass, where nothing is hotter than the rest. */
  hotConfigId?: string | null;
  /** Defaults to `DEFAULT_CONFIG_FLOOR_BYTES`. */
  floorBytes?: bigint;
};

export type RebalancedGrant = Allocation & {
  grantId: string;
  /** How many configs had either ceiling column moved — the convergence loop's work (F-027-t). */
  written: number;
  /**
   * The same split over the larger bag: what a graceful shutdown raises each
   * ceiling to (F-027-w). Row for row with `ceilings`.
   */
  walletBacked: ConfigCeiling[];
  /** What the wallet added to the bag at the Grant's locked rate. Zero for a prepaid Grant. */
  walletBackedBytes: bigint;
  /** Sold unlimited (F-111-q): nothing was split, and no config carries a ceiling. */
  unlimited: boolean;
};

@Injectable()
export class CeilingAllocatorService {
  constructor(private readonly prisma: PrismaService) {}

  /** One rebalance in a transaction of its own, for a caller with no other work to commit with it. */
  rebalanceForGrant(input: RebalanceGrant): Promise<RebalancedGrant> {
    return tenantTransaction(this.prisma, (tx) => this.rebalance(tx, input));
  }

  /**
   * Reads the Grant's bag and its configs, splits one across the other, and
   * writes the shares that moved.
   *
   * It runs in the **caller's** transaction, as the purchase does: F-027-u buys
   * the next block and rebalances in one, so there is no window where
   * `purchasedBytes` has advanced and no ceiling covers it — nor one where a
   * ceiling was written against money that failed to leave the wallet.
   *
   * Only configs that can carry traffic are in the split. A disabled or purged
   * one holding a share would be bytes the bag has spent and no panel can
   * serve, and the user would read it as a bag that empties while they are
   * offline.
   */
  async rebalance(tx: Prisma.TransactionClient, input: RebalanceGrant): Promise<RebalancedGrant> {
    const grant = await tx.grant.findUnique({
      where: { id: input.grantId },
      select: { id: true, userId: true, purchasedBytes: true, billingMode: true, meteredRate: true, trafficUnlimited: true },
    });
    if (!grant) throw new CeilingAllocationRefused('grant_not_found', input.grantId);
    // An unlimited Grant's bag is 0 and is not a bag (F-111-q). Split, it
    // would hand every config a 0-byte ceiling: a user who bought everything,
    // told by the panel they may carry nothing. Its configs keep no ceiling.
    if (grant.trafficUnlimited) {
      return { ceilings: [], unallocatedBytes: BigInt(0), grantId: grant.id, written: 0, walletBacked: [], walletBackedBytes: BigInt(0), unlimited: true };
    }

    const configs = await tx.config.findMany({
      where: { grantId: grant.id, status: ConfigStatus.active, desiredEnabled: true },
      select: {
        id: true,
        allocatedCeilingBytes: true,
        walletBackedCeilingBytes: true,
        counterState: { select: { lifetimeUpBytes: true, lifetimeDownBytes: true } },
        subAccount: { select: { dataCapBytes: true, isActive: true } },
        panel: { select: { maxLineRateBps: true } },
      },
    });

    const demands: ConfigDemand[] = configs.map((config) => ({
      configId: config.id,
      // No counter row yet means no pass has read this config: it has served nothing.
      servedBytes: config.counterState ? config.counterState.lifetimeUpBytes + config.counterState.lifetimeDownBytes : BigInt(0),
      // A deactivated sub-account is not a cap of zero — it is no cap at all (F-608).
      capBytes: config.subAccount?.isActive ? config.subAccount.dataCapBytes : null,
      lineRateBps: config.panel?.maxLineRateBps ?? null,
    }));
    const split = {
      floorBytes: input.floorBytes ?? DEFAULT_CONFIG_FLOOR_BYTES,
      floorSeconds: IDLE_FLOOR_SECONDS,
      hotConfigId: input.hotConfigId ?? null,
      configs: demands,
    };

    const allocation = allocateCeilings({ purchasedBytes: grant.purchasedBytes, ...split });

    // The shutdown figure: the **same split** over a bag of what was bought
    // plus what the wallet would still buy (F-027-w, ADR-0078). The same
    // function and the same order, so the result is larger config by config
    // rather than a second opinion about the allocation — which is what
    // `config_wallet_backed_ceiling_extends` refuses to hold otherwise. Every
    // other rule survives it: a sub-account cap is still a cap, and a config
    // that cannot carry traffic is still out of the split.
    const walletBackedBytes = await this.affordableBytes(tx, grant);
    const backed =
      walletBackedBytes > BigInt(0) ? allocateCeilings({ purchasedBytes: grant.purchasedBytes + walletBackedBytes, ...split }) : allocation;

    const allocatedById = new Map(allocation.ceilings.map((ceiling) => [ceiling.configId, ceiling.ceilingBytes]));
    // Never under the allocation. The split is monotone in the bag and the
    // property test holds it to that; this is the row the CHECK would refuse
    // if it ever were not, and a refused row here fails the block purchase
    // committing beside it — a user stalled over a figure only used at exit.
    const backedById = new Map(
      backed.ceilings.map((ceiling) => {
        const floor = allocatedById.get(ceiling.configId) as bigint;
        return [ceiling.configId, ceiling.ceilingBytes > floor ? ceiling.ceilingBytes : floor];
      }),
    );
    const current = new Map(configs.map((config) => [config.id, config]));
    // Either column moving is a write. The wallet moves far more often than
    // `purchasedBytes` does — every top-up changes it — so a write gated on the
    // allocation alone would leave the collector extending to yesterday's
    // balance on its way out.
    const moved = allocation.ceilings.filter((ceiling) => {
      const row = current.get(ceiling.configId);
      return row?.allocatedCeilingBytes !== ceiling.ceilingBytes || row?.walletBackedCeilingBytes !== backedById.get(ceiling.configId);
    });
    for (const ceiling of moved) {
      await tx.config.update({
        where: { id: ceiling.configId },
        data: { allocatedCeilingBytes: ceiling.ceilingBytes, walletBackedCeilingBytes: backedById.get(ceiling.configId) as bigint },
      });
    }

    return { ...allocation, grantId: grant.id, written: moved.length, walletBacked: backed.ceilings, walletBackedBytes, unlimited: false };
  }

  /**
   * What this Grant's owner could still buy right now, in bytes.
   *
   * A prepaid Grant gets nothing: no rate prices a byte for it (ADR-0073), and
   * nothing tops it up either — its ceiling is its quota, and this service
   * being down does not shrink that. A user with no wallet row is a balance of
   * zero, which is the same answer as an empty one.
   */
  private async affordableBytes(
    tx: Prisma.TransactionClient,
    grant: { userId: string; billingMode: VariantBillingMode; meteredRate: Prisma.Decimal | null },
  ): Promise<bigint> {
    if (grant.billingMode !== VariantBillingMode.metered || grant.meteredRate === null) return BigInt(0);
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId }, select: { cachedBalance: true } });
    return bytesAffordable(grant.meteredRate, wallet?.cachedBalance ?? new Prisma.Decimal(0));
  }
}
