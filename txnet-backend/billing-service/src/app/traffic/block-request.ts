import { Injectable } from '@nestjs/common';
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { BLOCK_REQUEST_MESSAGE_VERSION, WalletVersionConflict, runWithTenant, tenantTransaction, type BlockRequestMessage } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockPurchaseRefused, BlockPurchaseService, type BlockPurchaseRejection, type PurchasedBlock } from './block-purchase';
import { type Exhaustion, isShortOfFunds, suspendIfExhausted } from './exhaustion';
import { MIN_BLOCK_SECONDS } from './horizon';

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
 * overrun with it. `MIN_BLOCK_SECONDS` of the same rate floors it here, as it
 * did in the hot loop, and `purchase()` still never clamps a target up.
 */

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
  skipped: BlockRequestSkip | null;
  /** A wallet that could not fund the block. Nothing bought; reported, not thrown. */
  refused: BlockPurchaseRejection | null;
  /** Asked only when the wallet refused and the bag is spent (F-027-x). */
  exhausted: Exhaustion | null;
};

/** What one message came to. `raced` is a purchase another transaction won: routine, not a failure. */
export type BlockRequestHandled = { grantId: string; outcome: 'raced' | 'grant_not_found' | 'handled' };

const BITS_PER_BYTE = BigInt(8);

@Injectable()
export class BlockRequestService {
  constructor(
    private readonly prisma: PrismaService,
    /**
     * Cross-tenant because the read **produces** the tenant, as the hot loop's
     * config read does: the message names a Grant and no tenant.
     */
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly blocks: BlockPurchaseService,
  ) {}

  async handle(message: BlockRequestMessage): Promise<BlockRequestHandled> {
    if (message.version !== BLOCK_REQUEST_MESSAGE_VERSION) throw new UnsupportedBlockRequestVersion(message.version);
    const grant = await this.crossTenant.grant.findUnique({ where: { id: message.grantId }, select: { tenantId: true } });
    if (!grant) return { grantId: message.grantId, outcome: 'grant_not_found' };
    try {
      await runWithTenant({ id: grant.tenantId }, () => this.buy(message));
    } catch (error) {
      if (error instanceof WalletVersionConflict) return { grantId: message.grantId, outcome: 'raced' };
      throw error;
    }
    return { grantId: message.grantId, outcome: 'handled' };
  }

  /** One request in a transaction of its own, under the Grant's tenant. */
  buy(message: BlockRequestMessage): Promise<BlockRequestOutcome> {
    return tenantTransaction(this.prisma, (tx) => this.buyIn(tx, message));
  }

  async buyIn(tx: Prisma.TransactionClient, message: BlockRequestMessage): Promise<BlockRequestOutcome> {
    const none = { grantId: message.grantId, bought: null, refused: null, exhausted: null };
    const grant = await tx.grant.findUnique({
      where: { id: message.grantId },
      select: { id: true, status: true, billingMode: true, meteredRate: true, trafficUnlimited: true, purchasedBytes: true, consumedBytes: true },
    });
    if (!grant) return { ...none, skipped: 'grant_not_found' };
    if (grant.trafficUnlimited || grant.billingMode !== VariantBillingMode.metered || grant.meteredRate === null) {
      return { ...none, skipped: 'not_metered' };
    }
    if (grant.status !== GrantStatus.active) return { ...none, skipped: 'not_active' };
    if (grant.purchasedBytes !== BigInt(message.purchasedBytes)) return { ...none, skipped: 'stale' };

    const floor = (BigInt(message.rateBps) / BITS_PER_BYTE) * BigInt(MIN_BLOCK_SECONDS);
    const requested = BigInt(message.targetBytes);
    const targetBytes = requested > floor ? requested : floor;
    if (targetBytes <= BigInt(0)) return { ...none, skipped: 'target_not_positive' };

    try {
      const bought = await this.blocks.purchase(tx, { grantId: grant.id, targetBytes });
      return { ...none, bought, skipped: null };
    } catch (error) {
      if (!isShortOfFunds(error)) throw error;
      // `purchase()` refuses before it writes, so the transaction is clean. A
      // short wallet with bytes still in the bag is not exhaustion yet.
      const refused = (error as BlockPurchaseRefused).reason;
      const spent = grant.purchasedBytes - grant.consumedBytes <= BigInt(0);
      return { ...none, skipped: null, refused, exhausted: spent ? await suspendIfExhausted(tx, grant.id) : null };
    }
  }
}
