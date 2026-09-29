import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WalletTransaction } from '@prisma/client';

import { reviveFundedGrants } from '../entitlement/revival';
import { LedgerEntry, WalletLedgerService } from './wallet-ledger.service';

/**
 * Money arriving in a **user's** wallet, and what it is allowed to undo
 * (F-027-ap, ADR-0079).
 *
 * `WalletLedgerService` writes the row and moves the balance, and that is all
 * it should ever do — it lives in `shared-core` (ADR-0061) and `tenant-service`
 * writes it too, so entitlement cannot be reached from inside it. This is the
 * seam above it: append the ledger row, then revive the Grants that balance
 * now funds, **in the same transaction**. A user who pays has service back at
 * the moment the payment commits, without any process needing to be running
 * for it to happen.
 *
 * **Every user-wallet credit in this service goes through here.** There are
 * four — the gateway settlement, the fully-couponed free top-up, a gift
 * redemption and the remainder credit at a Grant's close — and
 * `wallet-credit-coverage.spec.ts` fails if a fifth appears that calls the
 * ledger directly. A refund from one Grant reviving another is deliberate:
 * money is money, and `walletCanBuy` is what judges whether it helps.
 *
 * **A debit does not belong here**, and there is no `debit` to match. Nothing
 * a debit does can revive anything, and giving this class one would invite the
 * reading that it is the ledger with extra steps rather than the place a
 * credit's consequences live.
 *
 * `TenantBillingLedger` — the reseller's billing wallet — is a different
 * ledger and stays outside this entirely: a reseller's balance has no Grant.
 */
@Injectable()
export class WalletCreditService {
  private readonly logger = new Logger(WalletCreditService.name);

  constructor(private readonly ledger: WalletLedgerService) {}

  /**
   * Credit the user's wallet and revive what the new balance funds.
   *
   * Answers the `WalletTransaction` the ledger wrote, unchanged, so this is a
   * drop-in for the call it replaces. The revival is a consequence rather than
   * a result: no caller has a decision to make about it, and one that needs
   * the count can read it off the log.
   */
  async credit(tx: Prisma.TransactionClient, entry: LedgerEntry): Promise<WalletTransaction> {
    const movement = await this.ledger.credit(tx, entry);

    const revivals = await reviveFundedGrants(tx, entry.userId, movement.balanceAfter);
    if (revivals.revived > 0) {
      this.logger.log(
        `credit ${movement.id} (${entry.reasonType}) revived ${revivals.revived} of ${revivals.scanned} suspended Grant(s) of user ${entry.userId}`,
      );
    }

    return movement;
  }
}
