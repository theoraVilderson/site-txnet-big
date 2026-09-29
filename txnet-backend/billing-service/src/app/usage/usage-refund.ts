import { Injectable } from '@nestjs/common';
import { GrantMeter, Prisma, WalletReasonType } from '@prisma/client';

import { WalletCreditService } from '../wallet/wallet-credit.service';
import { CENT, max, moveCursors, priceUnits, toAmount, ZERO } from './usage-price';

/**
 * A closing prepaid meter's remainder (F-118-g, ADR-0072 rule 3 for every
 * meter): the units bought and never used, priced **down** to a cent and
 * credited back as `usage_refund`, `billed` brought down to what was used.
 * Sub-cent dust stays taken, so a refund never exceeds what the blocks cost.
 *
 * Apart from `UsageSettlementService` for the reason `remainder-credit.ts` is
 * apart from the block purchaser: every user-wallet credit goes through
 * `WalletCreditService` (money back may revive what a short wallet stopped),
 * and a class that debits the ledger never credits it.
 */
@Injectable()
export class UsageRefundService {
  constructor(private readonly credits: WalletCreditService) {}

  async creditRemainder(tx: Prisma.TransactionClient, { grant, meter }: { grant: { id: string; userId: string }; meter: GrantMeter }): Promise<void> {
    const usedTo = max(meter.consumed, meter.includedQuantity);
    const left = meter.billed - usedTo;
    if (left <= ZERO) return;
    const cents = (left * priceUnits(meter)) / (meter.unitSize * CENT);
    if (cents === ZERO) return;
    // The cursor is the refund's record and its guard: claimed first, on the value read.
    await moveCursors(tx, meter, { billed: usedTo });
    await this.credits.credit(tx, {
      userId: grant.userId,
      amount: toAmount(cents),
      currencyCode: meter.currencyCode,
      reasonType: WalletReasonType.usage_refund,
      referenceId: grant.id,
    });
  }
}
