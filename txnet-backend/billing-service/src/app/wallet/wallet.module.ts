import { Module } from '@nestjs/common';

import { LocaleModule } from '../locale/locale.module';
import { WalletHistoryController } from './wallet-history.controller';
import { WalletHistoryService } from './wallet-history.service';
import { WalletLedgerService } from './wallet-ledger.service';

/**
 * The wallet: the credit/debit primitive every money movement goes through
 * (F-092-b), and the panel's read side over what it wrote (F-092-n).
 */
@Module({
  imports: [LocaleModule],
  controllers: [WalletHistoryController],
  providers: [WalletLedgerService, WalletHistoryService],
  exports: [WalletLedgerService, WalletHistoryService],
})
export class WalletModule {}
