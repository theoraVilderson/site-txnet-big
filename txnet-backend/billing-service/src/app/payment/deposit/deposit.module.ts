import { Module } from '@nestjs/common';

import { LocaleModule } from '../../locale/locale.module';
import { WalletModule } from '../../wallet/wallet.module';
import { CouponModule } from '../coupon/coupon.module';
import { GatewayModule } from '../gateway/gateway.module';
import { FxRateReader } from '../pricing/fx-rate.reader';
import { DepositController } from './deposit.controller';
import { DepositQuoteService } from './deposit-quote.service';
import { DepositStartService } from './deposit-start.service';

/**
 * The top-up page (F-092-o, F-092-i): the gateway list, the quote, and starting
 * the payment the quote described. `WalletModule` is here for the free path
 * alone — a fully discounted top-up credits the wallet itself, because no
 * gateway will ever call back about it.
 */
@Module({
  imports: [LocaleModule, CouponModule, GatewayModule, WalletModule],
  controllers: [DepositController],
  providers: [DepositQuoteService, DepositStartService, FxRateReader],
  exports: [DepositQuoteService, DepositStartService],
})
export class DepositModule {}
