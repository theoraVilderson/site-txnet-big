import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LocaleModule } from '../locale/locale.module';
import { VpnReserve, installVpnReserve } from '../traffic/vpn-reserve';
import { SpendingCaps, installSpendingCaps } from '../usage/cap-funding';
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
 * `VpnReserve` is built here, sized by `VPN_RESERVE_BYTES`, and installed for
 * the revive paths, which top a Grant's reserve in the transaction that
 * brings it back (F-118-b). `SpendingCaps` is installed beside it: every
 * funding path bounds a capped Grant by its cap (F-118-i).
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
      // Installed too, for the free functions that bring a Grant back (vpn-reserve.ts).
      useFactory: (holds: WalletHoldService, config: ConfigService) =>
        installVpnReserve(new VpnReserve(holds, BigInt(config.getOrThrow<number>('VPN_RESERVE_BYTES')))),
    },
    { provide: SpendingCaps, useFactory: () => installSpendingCaps(new SpendingCaps()) },
    WalletCreditService,
    WalletHistoryService,
  ],
  exports: [WalletLedgerService, WalletHoldService, VpnReserve, SpendingCaps, WalletCreditService, WalletHistoryService],
})
export class WalletModule {}
