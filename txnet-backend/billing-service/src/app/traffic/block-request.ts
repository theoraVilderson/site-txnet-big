import { Injectable } from '@nestjs/common';
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { BLOCK_REQUEST_MESSAGE_VERSION, WalletVersionConflict, runWithTenant, tenantTransaction, type BlockRequestMessage } from '@txnet-backend/shared-core';

import { UsageSettlementRefused } from '../usage/usage-price';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockPurchaseRefused, BlockPurchaseService, type BlockPurchaseRejection, type PurchasedBlock } from './block-purchase';
import { type Exhaustion, isShortOfFunds, suspendIfExhausted } from './exhaustion';
import { noticeLowBalance } from './low-balance';
import { vpnMeterOf } from './vpn-meter';
import { NO_VPN_RESERVE, VpnReserve } from './vpn-reserve';
import type { ServedPostpaid } from './vpn-postpaid';

/**
 * A metered Grant's next block, asked for by the lease planner (F-027-dc,
 * ADR-0093 amendment 2026-09-27) — the only path that buys one.
 *
 * `network-service` sees the counter, so it knows when the bag runs out inside
 * its horizon; this side keeps the money, so it decides whether a block is
 * bought. The planner already leases the wallet's reserve (`Quota` is the bag
 * plus what the balance still buys), so a request answered a pass late costs
 * the user nothing: it is the bag catching up with bytes already leased.
 *
 * **The bag it names is the guard.** A request is bought only while the Grant
 * still holds exactly the `purchasedBytes` the planner saw. Two turns over two
 * panels may ask for one bag, and a request may wait in the queue while
 * another is bought: the second finds the bag moved and is dropped, never
 * bought twice. The planner asks again, on the new bag, once it nears its end.
 *
 * **The planner sizes it, this floors it.** The target is a horizon of the
 * measured rate less what is left, so a bag already past its end buys the
 * overrun with it. `MIN_BLOCK_SECONDS` of the same rate floors it here, and
 * `purchase()` still never clamps a target up.
 *
 * **A postpaid Grant is not sold a block** (F-118-k): the same request
 * captures what was served from its hold and holds the target on top
 * (`VpnReserve.servePostpaid`). The bag guard, the floor, the short-wallet
 * report and the exhaustion check are the same.
 */

/**
 * The block floor, in seconds of the requested rate (F-027-am).
 *
 * Every block is a `traffic_consumption` row, and a target with no floor under
 * it buys one on every request: a Grant a second inside the horizon would buy
 * one second of traffic, over and over, for as long as the user stays near its
 * end. Flooring the **target** bounds that at one row a minute per Grant,
 * whatever the line speed, because a faster user's minute is a bigger block
 * rather than a more frequent one.
 */
export const MIN_BLOCK_SECONDS = 60;

/** Why nothing was asked of the wallet. Nothing was written. */
export type BlockRequestSkip = 'grant_not_found' | 'not_active' | 'not_metered' | 'stale' | 'target_not_positive';

/** A request written against a wire this consumer does not read. Redelivery cannot fix it: it dead-letters. */
export class UnsupportedBlockRequestVersion extends Error {
  constructor(readonly version: number) {
    super(`block request message version ${version} — billing reads ${BLOCK_REQUEST_MESSAGE_VERSION}`);
    this.name = 'UnsupportedBlockRequestVersion';
  }
}

export type BlockRequestOutcome = {
  grantId: string;
  bought: PurchasedBlock | null;
  /** A postpaid Grant's answer instead of a block: captured, then held (F-118-k). */
  served?: ServedPostpaid | null;
  skipped: BlockRequestSkip | null;
  /** A wallet that could not fund the block. Nothing bought; reported, not thrown. */
  refused: BlockPurchaseRejection | 'insufficient_funds' | null;
  /** Asked only when the wallet refused and the bag is spent (F-027-x). */
  exhausted: Exhaustion | null;
  /** After a purchase: the wallet's low-balance notice told, or re-armed by a balance back over it (F-601-g). */
  lowBalance: 'told' | 'rearmed' | null;
};

/** What one message came to. `raced` is a purchase another transaction won: routine, not a failure. */
export type BlockRequestHandled = { grantId: string; outcome: 'raced' | 'grant_not_found' | 'handled' };

const BITS_PER_BYTE = BigInt(8);

@Injectable()
export class BlockRequestService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * Cross-tenant because the read **produces** the tenant: the message
     * names a Grant and no tenant.
     */
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly blocks: BlockPurchaseService,
    // Defaulted so a spec that builds the request by hand serves no postpaid Grant.
    private readonly reserve: VpnReserve = NO_VPN_RESERVE,
  ) {}

  async handle(message: BlockRequestMessage): Promise<BlockRequestHandled> {
    if (message.version !== BLOCK_REQUEST_MESSAGE_VERSION) throw new UnsupportedBlockRequestVersion(message.version);
    const grant = await this.crossTenant.grant.findUnique({ where: { id: message.grantId }, select: { tenantId: true } });
    if (!grant) return { grantId: message.grantId, outcome: 'grant_not_found' };
    try {
      await runWithTenant({ id: grant.tenantId }, () => this.buy(message));
    } catch (error) {
      if (error instanceof WalletVersionConflict) return { grantId: message.grantId, outcome: 'raced' };
      // A postpaid capture that raced the hourly one: nothing written, the planner asks again.
      if (error instanceof UsageSettlementRefused && error.reason === 'cursor_moved') return { grantId: message.grantId, outcome: 'raced' };
      throw error;
    }
    return { grantId: message.grantId, outcome: 'handled' };
  }

  /** One request in a transaction of its own, under the Grant's tenant. */
  buy(message: BlockRequestMessage): Promise<BlockRequestOutcome> {
    return tenantTransaction(this.prisma, (tx) => this.buyIn(tx, message));
  }

  async buyIn(tx: Prisma.TransactionClient, message: BlockRequestMessage): Promise<BlockRequestOutcome> {
    const none = { grantId: message.grantId, bought: null, refused: null, exhausted: null, lowBalance: null };
    const grant = await tx.grant.findUnique({
      where: { id: message.grantId },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        status: true,
        billingMode: true,
        trafficUnlimited: true,
        purchasedBytes: true,
        consumedBytes: true,
        lowBalanceNoticeAt: true,
      },
    });
    if (!grant) return { ...none, skipped: 'grant_not_found' };
    const meter = grant.trafficUnlimited || grant.billingMode !== VariantBillingMode.metered ? null : await vpnMeterOf(tx, grant.id);
    if (!meter) return { ...none, skipped: 'not_metered' };
    if (grant.status !== GrantStatus.active) return { ...none, skipped: 'not_active' };
    if (grant.purchasedBytes !== BigInt(message.purchasedBytes)) return { ...none, skipped: 'stale' };

    const floor = (BigInt(message.rateBps) / BITS_PER_BYTE) * BigInt(MIN_BLOCK_SECONDS);
    const requested = BigInt(message.targetBytes);
    const targetBytes = requested > floor ? requested : floor;
    if (targetBytes <= BigInt(0)) return { ...none, skipped: 'target_not_positive' };
    const priced = { ...grant, rate: meter.unitPrice };
    if (await this.reserve.isPostpaid(tx, grant.id)) return this.servePostpaid(tx, priced, targetBytes, none);

    try {
      const bought = await this.blocks.purchase(tx, { grantId: grant.id, targetBytes });
      // The balance the debit left, seen while the user is still served (F-601-g).
      return { ...none, bought, skipped: null, lowBalance: await noticeLowBalance(tx, priced, bought.balanceAfter) };
    } catch (error) {
      if (!isShortOfFunds(error)) throw error;
      // `purchase()` refuses before it writes, so the transaction is clean. A
      // short wallet with bytes still in the bag is not exhaustion yet.
      const refused = (error as BlockPurchaseRefused).reason;
      const spent = grant.purchasedBytes - grant.consumedBytes <= BigInt(0);
      return { ...none, skipped: null, refused, exhausted: spent ? await suspendIfExhausted(tx, grant.id) : null };
    }
  }

  private async servePostpaid(
    tx: Prisma.TransactionClient,
    grant: { id: string; tenantId: string; userId: string; rate: Prisma.Decimal | null; lowBalanceNoticeAt: Date | null; purchasedBytes: bigint; consumedBytes: bigint },
    targetBytes: bigint,
    none: Omit<BlockRequestOutcome, 'skipped'>,
  ): Promise<BlockRequestOutcome> {
    try {
      const served = await this.reserve.servePostpaid(tx, grant.id, targetBytes);
      // What is left to spend, seen while the user is still served (F-601-g).
      const wallet = await tx.wallet.findUnique({ where: { ownerUserId: grant.userId } });
      const free = wallet ? wallet.cachedBalance.minus(wallet.heldAmount) : new Prisma.Decimal(0);
      return { ...none, served, skipped: null, lowBalance: await noticeLowBalance(tx, grant, free) };
    } catch (error) {
      if (!(error instanceof UsageSettlementRefused && error.reason === 'insufficient_funds')) throw error;
      // Refused before any write: a hold of nothing captures nothing, so the transaction is clean.
      const spent = grant.purchasedBytes - grant.consumedBytes <= BigInt(0);
      return { ...none, skipped: null, refused: 'insufficient_funds', exhausted: spent ? await suspendIfExhausted(tx, grant.id) : null };
    }
  }
}
