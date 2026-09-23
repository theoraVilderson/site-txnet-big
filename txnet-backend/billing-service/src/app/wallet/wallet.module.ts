import { Module } from '@nestjs/common';

import { LocaleModule } from '../locale/locale.module';
import { WalletCreditService } from './wallet-credit.service';
import { WalletHistoryController } from './wallet-history.controller';
import { WalletHistoryService } from './wallet-history.service';
import { WalletLedgerService } from './wallet-ledger.service';

/**
 * The wallet: the credit/debit primitive every money movement goes through
 * (F-092-b), and the panel's read side over what it wrote (F-092-n).
 *
 * A credit to a *user's* wallet goes through `WalletCreditService` rather than
 * the ledger directly, because money arriving revives the Grants it funds in
 * the same transaction (F-027-ap, ADR-0079). The ledger stays exported: a
 * debit, and the reseller billing wallet, have nothing to revive.
 */
@Module({
  imports: [LocaleModule],
  controllers: [WalletHistoryController],
  providers: [WalletLedgerService, WalletCreditService, WalletHistoryService],
  exports: [WalletLedgerService, WalletCreditService, WalletHistoryService],
})
export class WalletModule {}
