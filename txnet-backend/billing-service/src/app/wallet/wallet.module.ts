import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LocaleModule } from '../locale/locale.module';
import { VpnReserve } from '../traffic/vpn-reserve';
import { WalletCreditService } from './wallet-credit.service';
import { WalletHistoryController } from './wallet-history.controller';
import { WalletHistoryService } from './wallet-history.service';
import { WalletHoldService, WalletLedgerService } from './wallet-ledger.service';

/**
 * The wallet: the credit/debit primitive every money movement goes through
 * (F-092-b), and the panel's read side over what it wrote (F-092-n).
 *
 * A credit to a *user's* wallet goes through `WalletCreditService` rather than
 * the ledger directly, because money arriving revives the Grants it funds in
 * the same transaction (F-027-ap, ADR-0079). The ledger stays exported: a
 * debit, and the reseller billing wallet, have nothing to revive.
 *
 * `WalletHoldService` locks money a wallet has promised (F-118-a, ADR-0105
 * (6)); the reserve (F-118-b) and postpaid settlement (F-118-g) call it.
 * `VpnReserve` is built here, sized by `VPN_RESERVE_BYTES`, because a credit
 * that revives a Grant tops its reserve back in the same transaction.
 */
@Module({
  imports: [LocaleModule],
  controllers: [WalletHistoryController],
  providers: [
    WalletLedgerService,
    WalletHoldService,
    {
      provide: VpnReserve,
      inject: [WalletHoldService, ConfigService],
      useFactory: (holds: WalletHoldService, config: ConfigService) => new VpnReserve(holds, BigInt(config.getOrThrow<number>('VPN_RESERVE_BYTES'))),
    },
    WalletCreditService,
    WalletHistoryService,
  ],
  exports: [WalletLedgerService, WalletHoldService, VpnReserve, WalletCreditService, WalletHistoryService],
})
export class WalletModule {}
