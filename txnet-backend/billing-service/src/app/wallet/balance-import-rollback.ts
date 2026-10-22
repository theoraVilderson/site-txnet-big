import { LedgerDirection, WalletReasonType, type MigrationItem, type Prisma } from '@prisma/client';

import { BalanceRowRefused } from './balance-import';
import { InsufficientFunds, type WalletLedgerService } from './wallet-ledger.service';

/*
 * The rollback's write for a balance file's row (F-209-a, billing
 * `contract.balance-import.md` rule 7). Apart from the commit's credit: a file
 * holding the ledger may debit it, never credit it (ADR-0079's guard,
 * `revival.spec.ts`).
 */

/**
 * The rollback's write for one row (F-211 on a csv run): the debit of exactly
 * what the commit credited, same reason, same item. A wallet that moved since
 * the credit — the money spent, more added, a currency change — or that cannot
 * cover it is `wallet_used`: its money is the customer's now, as a renewed
 * Grant is (entitlement `contract.import.md` rule 24).
 */
export async function reverseBalanceRow(tx: Prisma.TransactionClient, ledger: Pick<WalletLedgerService, 'debit'>, item: Pick<MigrationItem, 'id'>): Promise<void> {
  const credit = await tx.walletTransaction.findFirst({
    where: { reasonType: WalletReasonType.migration_import, referenceId: item.id, direction: LedgerDirection.credit },
    select: { walletId: true, amount: true, currencyCode: true, createdAt: true, wallet: { select: { ownerUserId: true } } },
  });
  // The commit credits and marks the item `created` in one transaction: a created item has its credit.
  if (!credit) throw new Error(`item ${item.id} was committed with no credit`);
  const moved = await tx.walletTransaction.count({ where: { walletId: credit.walletId, createdAt: { gt: credit.createdAt }, reasonType: { not: WalletReasonType.migration_import } } });
  if (moved > 0) throw new BalanceRowRefused('wallet_used');
  try {
    await ledger.debit(tx, { userId: credit.wallet.ownerUserId, amount: credit.amount, currencyCode: credit.currencyCode, reasonType: WalletReasonType.migration_import, referenceId: item.id });
  } catch (e) {
    // A hold placed since locks part of it: the free balance cannot give it back.
    if (e instanceof InsufficientFunds) throw new BalanceRowRefused('wallet_used');
    throw e;
  }
}
