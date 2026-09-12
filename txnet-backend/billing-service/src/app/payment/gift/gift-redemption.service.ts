import { Injectable } from '@nestjs/common';
import { Prisma, WalletReasonType } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { WalletLedgerService } from '../../wallet/wallet-ledger.service';
import { normalizeCouponCodes } from '../coupon/coupon-validation';

/**
 * Redeeming a gift code straight into the wallet (F-092-m; D-21).
 *
 * A gift code is a `wallet_credit` coupon, not a table of its own. The discount
 * engine refuses one on purpose — a discount is held while a payment runs and
 * confirmed when it lands, and a gift has no payment. So this is the one code
 * path that reads a coupon and moves money in the same breath: the redemption
 * is written `confirmed` and the wallet credited inside one
 * `tenantTransaction`, and either both commit or neither does (billing
 * invariants 1-3, 11).
 *
 * The gates and the row lock are `billing.redeem_gift_coupon`'s, for the reason
 * `20260911000200_coupon_reservation` gives about the discount path: a tenant's
 * connection may read a platform coupon but may not update it, and the last
 * slot has to be decided under a lock rather than by a count the caller read a
 * moment ago.
 *
 * Kept from the legacy `P/gift/route.ts`: one code at a time, a refusal that
 * says why, and a ledger row that records the credit. Not kept: validating with
 * the discount engine and then reserving, committing and crediting as four
 * steps with a `walletBalance` `$inc` at the end (the balance was a computed
 * `UPDATE` — invariant 1), the Persian literals (C-01), and the title carrying
 * the code into free text where nothing could read it back.
 */

/** Why a code was refused. Closed — the controller maps each to an i18n key. */
export type GiftRejection =
  /** Unknown, inactive, another tenant's, or targeted at someone else — never told apart. */
  | 'not_found'
  /** A real coupon, but a discount one: it belongs in the top-up box, not here. */
  | 'not_a_gift_code'
  | 'expired'
  | 'per_user_limit_reached'
  /** `usedCount + reservedCount` has reached `totalUsageLimit`. */
  | 'capacity_reached';

export type GiftRedemption = {
  /** The `coupon_redemption` row; the ledger entry's `referenceId`. */
  redemptionId: string;
  /** As stored, not as typed. */
  code: string;
  /** Base currency (ADR-0019), what the wallet gained. */
  credited: Prisma.Decimal;
  /** The wallet's balance after this credit, from the ledger row itself. */
  balanceAfter: Prisma.Decimal;
};

/** The user's code cannot be redeemed. Nothing was written. */
export class GiftCodeRefused extends Error {
  constructor(
    readonly code: string,
    readonly reason: GiftRejection,
  ) {
    super(`gift code ${code} was refused: ${reason}`);
    this.name = 'GiftCodeRefused';
  }
}

const REFUSALS: readonly GiftRejection[] = [
  'not_found',
  'not_a_gift_code',
  'expired',
  'per_user_limit_reached',
  'capacity_reached',
];

type RedeemRow = { outcome: string; redemption_id: string | null; credited: Prisma.Decimal | null };

@Injectable()
export class GiftRedemptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: WalletLedgerService,
  ) {}

  /**
   * Uses the code and credits the wallet, or throws `GiftCodeRefused`.
   *
   * The code is normalised the way the discount engine normalises the ones
   * typed beside it, so `giftcode` and ` GIFTCODE ` are the same code in both
   * boxes.
   */
  async redeem(request: { userId: string; code: string }): Promise<GiftRedemption> {
    const { userId } = request;
    const [code] = normalizeCouponCodes([request.code]);
    // Blank is refused here rather than at the database: it is the one input
    // the function treats as a caller bug, and from a route it is a user's.
    if (!code) throw new GiftCodeRefused(request.code.trim(), 'not_found');

    return tenantTransaction(this.prisma, async (tx) => {
      const [row] = await tx.$queryRaw<RedeemRow[]>`
        SELECT outcome, redemption_id, credited
          FROM billing.redeem_gift_coupon(${code}::text, ${userId}::uuid)`;

      if (row.outcome !== 'redeemed') {
        if (!REFUSALS.includes(row.outcome as GiftRejection)) {
          throw new Error(`redeem_gift_coupon answered an unknown outcome: ${row.outcome}`);
        }
        // Nothing was written, but the throw rolls the transaction back anyway:
        // the caller owns nothing here that a refusal should keep.
        throw new GiftCodeRefused(code, row.outcome as GiftRejection);
      }

      const credited = row.credited as Prisma.Decimal;
      const entry = await this.ledger.credit(tx, {
        userId,
        amount: credited,
        reasonType: WalletReasonType.coupon_redemption,
        // The redemption row, not the coupon: a coupon may be redeemed again,
        // a redemption never is, so this is what makes the credit traceable to
        // one use (invariant 11).
        referenceId: row.redemption_id as string,
      });

      return {
        redemptionId: row.redemption_id as string,
        code,
        credited,
        balanceAfter: entry.balanceAfter,
      };
    });
  }
}
