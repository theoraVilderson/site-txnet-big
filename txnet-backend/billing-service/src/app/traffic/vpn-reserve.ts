import { Injectable, Logger } from '@nestjs/common';
import { GrantStatus, Prisma, VariantBillingMode, WalletHoldStatus } from '@prisma/client';
import { METER_KEYS, METERED_RATE_UNIT_BYTES, WalletVersionConflict, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { withinCap } from '../usage/cap-funding';
import { WalletHoldService, WalletLedgerService } from '../wallet/wallet-ledger.service';
import { postpaidVpnMeter, VpnPostpaid } from './vpn-postpaid';
import { RESERVED_WHERE, releaseAboveShare, reserveShareOf } from './reserve-share';
import { vpnMeterOf } from './vpn-meter';

/**
 * The VPN reserve as held money (F-118-b, ADR-0105 (8), network
 * `contract.reserve.md`).
 *
 * A metered Grant's configs keep headroom past the bag it bought, so a first
 * connect or a switch of inbound is not cut in its first second. Until F-118-b
 * that headroom was what the whole balance would buy, read and never locked:
 * a product purchase or a second meter spent the same money, and the bytes
 * served in between were served unfunded. Now each Grant has one hold,
 * `ownerRef` = the Grant's id, of `VPN_RESERVE_BYTES` at its locked rate
 * (user, 2026-09-29: a fixed size, so the rest of the wallet stays free), and
 * the planner leases what that hold buys and nothing more.
 *
 * - **Topped** at issue, after every block, on every way back to active (the
 *   revive in `entitlement/purge.ts`, `unfreezeGrant`), and by the minute's
 *   sweep as a backstop (a deposit into a short reserve, a missed path).
 * - **Spent** only by its own Grant's next block (`BlockPurchaseService`),
 *   which counts it as its own money, so the overrun a reserve served is paid.
 * - **Released** when the Grant stops being planned: a suspension, a freeze,
 *   a cancel, a close; the sweep releases any a path missed.
 *
 * A **postpaid** VPN Grant (F-118-k) has no reserve: every call here hands it
 * to `VpnPostpaid` (`vpn-postpaid.ts`), whose meter hold is its headroom —
 * topped to the same floor, captured and released on the same paths.
 */

/** Bytes per unit of a `vpn.traffic` rate (ADR-0073). */
const GIB = BigInt(METERED_RATE_UNIT_BYTES);
/** `grant_meter.unitPrice` is `Decimal(18, 8)`. */
const RATE_SCALE = 8;
const RATE_UNIT = BigInt(100_000_000);
const CENTS = BigInt(100);
const ZERO = new Prisma.Decimal(0);

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - BigInt(1)) / b;

/**
 * The reserve's money: `reserveBytes` at the rate, rounded **up** to a whole
 * cent (so it buys at least them), clamped to the whole cents `available`.
 * A short balance holds less, not nothing. A rate no arithmetic prices, or a
 * reserve of zero, holds nothing — a Grant with no headroom, not a failure.
 */
export function sizeReserve(input: { rate: Prisma.Decimal; reserveBytes: bigint; available: Prisma.Decimal }): Prisma.Decimal {
  const { rate, reserveBytes, available } = input;
  if (reserveBytes <= BigInt(0) || rate.lte(0) || rate.decimalPlaces() > RATE_SCALE || available.lte(0)) return ZERO;
  const rateUnits = BigInt(rate.mul(RATE_UNIT.toString()).toFixed(0));
  const wanted = ceilDiv(rateUnits * reserveBytes * CENTS, RATE_UNIT * GIB);
  const affordable = BigInt(available.mul(CENTS.toString()).floor().toFixed(0));
  const cents = wanted < affordable ? wanted : affordable;
  return new Prisma.Decimal(cents.toString()).div(CENTS.toString());
}

type ReserveGrant = {
  status: GrantStatus;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
};


const isReserved = (g: ReserveGrant): boolean =>
  (g.status === GrantStatus.active || g.status === GrantStatus.pending) &&
  g.billingMode === VariantBillingMode.metered &&
  !g.trafficUnlimited;

function openReserve(tx: Prisma.TransactionClient, walletId: string, grantId: string) {
  return tx.walletHold.findFirst({ where: { walletId, ownerRef: grantId, status: WalletHoldStatus.open } });
}

/** For a release, which needs no size: every hold write goes through the one service (holds contract). */
const HOLDS = new WalletHoldService(new WalletLedgerService());

/**
 * A Grant that just stopped being planned gives its reserve back, in the
 * caller's transaction. Only a metered Grant ever holds one, so any other
 * reads one row and nothing else.
 */
export async function releaseVpnReserveOf(tx: Prisma.TransactionClient, grantId: string): Promise<Prisma.Decimal> {
  const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { id: true, userId: true, billingMode: true } });
  if (!grant || grant.billingMode !== VariantBillingMode.metered) return ZERO;
  return releaseVpnReserve(tx, grant);
}

/** A postpaid Grant's release, which needs no floor either. Built on first use: the modules import each other. */
let postpaidRelease: VpnPostpaid | undefined;
const POSTPAID = (): VpnPostpaid => (postpaidRelease ??= new VpnPostpaid(HOLDS, BigInt(0)));

/**
 * Releases a Grant's reserve whole, in the caller's transaction, and answers
 * what it gave back. No reserve is no write, so a second call moves nothing.
 * A postpaid Grant's meter hold is captured first, then released (F-118-k).
 */
export async function releaseVpnReserve(tx: Prisma.TransactionClient, grant: { id: string; userId: string }): Promise<Prisma.Decimal> {
  return (await postpaidVpnMeter(tx, grant.id)) ? POSTPAID().close(tx, grant) : releaseGrantReserve(tx, grant);
}

async function releaseGrantReserve(tx: Prisma.TransactionClient, grant: { id: string; userId: string }): Promise<Prisma.Decimal> {
  const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
  const open = wallet ? await openReserve(tx, wallet.id, grant.id) : null;
  if (!open) return ZERO;
  await HOLDS.release(tx, { userId: grant.userId, ownerRef: grant.id });
  return open.amount;
}

export class VpnReserve {
  private readonly postpaid: VpnPostpaid;

  /**
   * `holds` null is a service built by hand with no wallet — a spec of
   * something else — and holds nothing. `WalletModule` builds the real one
   * with `VPN_RESERVE_BYTES`.
   */
  constructor(
    private readonly holds: WalletHoldService | null,
    readonly bytes: bigint,
  ) {
    this.postpaid = new VpnPostpaid(holds, bytes);
  }

  /** A Grant whose `vpn.traffic` is postpaid (F-118-k): held and captured, never sold a block. */
  async isPostpaid(tx: Prisma.TransactionClient, grantId: string): Promise<boolean> {
    return this.holds !== null && (await postpaidVpnMeter(tx, grantId)) !== null;
  }

  /** The planner's request for a postpaid Grant (`VpnPostpaid.serve`). */
  servePostpaid(tx: Prisma.TransactionClient, grantId: string, extraBytes: bigint) {
    return this.postpaid.serve(tx, grantId, extraBytes);
  }

  /** What is held for this Grant now: the money its own block may spend. */
  async heldFor(tx: Prisma.TransactionClient, grant: { id: string; userId: string }): Promise<Prisma.Decimal> {
    if (!this.holds) return ZERO;
    if (await this.isPostpaid(tx, grant.id)) return this.postpaid.heldFor(tx, grant);
    const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    const open = wallet ? await openReserve(tx, wallet.id, grant.id) : null;
    return open?.amount ?? ZERO;
  }

  async release(tx: Prisma.TransactionClient, grant: { id: string; userId: string }): Promise<Prisma.Decimal> {
    if (!this.holds) return ZERO;
    return (await this.isPostpaid(tx, grant.id)) ? this.postpaid.close(tx, grant) : releaseGrantReserve(tx, grant);
  }

  /**
   * Holds this Grant's reserve up to its target, from the free balance plus
   * what it already holds, in the caller's transaction; answers what is held.
   * At its target, it writes nothing. A Grant the planner leases no reserve
   * to holds nothing here (the sweep releases one it still has).
   */
  async top(tx: Prisma.TransactionClient, grantId: string): Promise<Prisma.Decimal> {
    if (!this.holds) return ZERO;
    if (await this.isPostpaid(tx, grantId)) return this.postpaid.top(tx, grantId);
    const grant = await tx.grant.findUnique({
      where: { id: grantId },
      select: { id: true, userId: true, status: true, billingMode: true, trafficUnlimited: true },
    });
    const meter = grant && isReserved(grant) ? await vpnMeterOf(tx, grantId) : null;
    if (!grant || !meter) return ZERO;
    let wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
    // A rate in another currency than the wallet is not this code's to convert (C-02).
    if (!wallet || wallet.currencyCode !== meter.currencyCode) return ZERO;

    const held = (await openReserve(tx, wallet.id, grant.id))?.amount ?? ZERO;
    // Never more than its part of the owner's headroom (F-118-ag, F-118-an):
    // another Grant holding more gives the rest back first, spending nothing.
    const share = await reserveShareOf(tx, grant);
    if (share && (await releaseAboveShare(tx, grant.userId, share)).gt(0)) {
      wallet = (await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } })) ?? wallet;
    }
    const free = wallet.cachedBalance.minus(wallet.heldAmount).plus(held);
    const target = sizeReserve({
      rate: meter.unitPrice,
      reserveBytes: this.bytes,
      // Inside the Grant's spending cap, if it has one (F-118-i), and its part
      // of the quarter all headroom may hold (F-118-an).
      available: await withinCap(tx, grant, share && share.headroom.lt(free) ? share.headroom : free, held),
    });
    const entry = { userId: grant.userId, ownerRef: grant.id };
    if (target.gt(held)) await this.holds.hold(tx, { ...entry, amount: target.minus(held), currencyCode: wallet.currencyCode });
    else if (target.lt(held)) await this.holds.release(tx, { ...entry, amount: held.minus(target) });
    return target;
  }
}

/** For a service built by hand: holds nothing, reads nothing. */
export const NO_VPN_RESERVE = new VpnReserve(null, BigInt(0));

/**
 * The reserve a Grant brought back to active is topped with: the one
 * `WalletModule` built from `VPN_RESERVE_BYTES`, installed once at boot.
 * Every way back — a top-up, a renewal, an unfreeze, a reseller's or a bulk
 * job's — ends in `purge.ts`'s revive or `unfreezeGrant`, free functions its
 * many callers reach without DI; they top through this rather than each
 * caller threading a reserve. Until installed (a spec) it holds nothing.
 */
let installed: VpnReserve = NO_VPN_RESERVE;

export function installVpnReserve(reserve: VpnReserve): VpnReserve {
  installed = reserve;
  return reserve;
}

/** Tops a Grant just brought back to active, in the caller's transaction (F-118-b). */
export function topVpnReserve(tx: Prisma.TransactionClient, grantId: string): Promise<Prisma.Decimal> {
  return installed.top(tx, grantId);
}

export type ReserveDueResult = { scanned: number; topped: number; released: number; errors: number };

/** Grants per page of the sweep's scan. */
const SWEEP_PAGE = 500;

/**
 * The minute's sweep (`POST /api/internal/billing/traffic/reserve-due`, asked
 * by worker-service's `vpn_reserve`): every reserved Grant topped to its
 * target, and every reserve of a Grant no longer reserved released. The
 * paths that move a Grant do it at once where they can; this is what makes a
 * missed one cost a minute rather than money locked for nobody.
 *
 * Safe to run twice: a reserve at its target, or none, writes nothing.
 */
@Injectable()
export class VpnReserveSweep {
  private readonly logger = new Logger(VpnReserveSweep.name);

  constructor(
    private readonly prisma: PrismaService,
    /** Cross-tenant because the scan produces the tenant; each write opens its own. */
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly reserve: VpnReserve,
  ) {}

  async reserveDue(): Promise<ReserveDueResult> {
    const result: ReserveDueResult = { scanned: 0, topped: 0, released: 0, errors: 0 };

    let cursor: string | undefined;
    for (;;) {
      const page = await this.crossTenant.grant.findMany({
        where: { ...RESERVED_WHERE, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, tenantId: true, userId: true },
        orderBy: { id: 'asc' },
        take: SWEEP_PAGE,
      });
      for (const g of page) {
        result.scanned++;
        await this.each(g, result, async (tx) => {
          const before = await this.reserve.heldFor(tx, g);
          if (!(await this.reserve.top(tx, g.id)).eq(before)) result.topped++;
        });
      }
      if (page.length < SWEEP_PAGE) break;
      cursor = page[page.length - 1].id;
    }

    // Open holds whose owner is a Grant no longer reserved, or a postpaid
    // Grant's `vpn.traffic` meter (F-118-k). Any other meter's hold is its
    // settlement's, and matches neither.
    const open = await this.crossTenant.walletHold.findMany({ where: { status: WalletHoldStatus.open }, select: { ownerRef: true } });
    const owners = open.map((h) => h.ownerRef);
    const stale = [
      ...(await this.crossTenant.grant.findMany({
        where: { id: { in: owners }, NOT: RESERVED_WHERE },
        select: { id: true, tenantId: true, userId: true },
      })),
      ...(
        await this.crossTenant.grantMeter.findMany({
          where: { id: { in: owners }, meterKey: METER_KEYS.vpnTraffic, grant: { NOT: RESERVED_WHERE } },
          select: { grant: { select: { id: true, tenantId: true, userId: true } } },
        })
      ).map((m) => m.grant),
    ];
    for (const g of stale) {
      result.scanned++;
      await this.each(g, result, async (tx) => {
        if ((await releaseVpnReserve(tx, g)).gt(0)) result.released++;
      });
    }
    return result;
  }

  private async each(g: { id: string; tenantId: string }, result: ReserveDueResult, work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
    try {
      await runWithTenant({ id: g.tenantId }, () => tenantTransaction(this.prisma, work));
    } catch (e) {
      // A lost race is the next minute's; anything else is counted and told.
      if (e instanceof WalletVersionConflict) return;
      result.errors++;
      this.logger.error(`reserve of grant ${g.id} failed: ${(e as Error).message}`);
    }
  }
}
