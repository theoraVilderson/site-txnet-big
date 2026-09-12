import { Module } from '@nestjs/common';

import { LocaleModule } from '../../locale/locale.module';
import { WalletModule } from '../../wallet/wallet.module';
import { CouponModule } from '../coupon/coupon.module';
import { GatewayModule } from '../gateway/gateway.module';
import { FxRateReader } from '../pricing/fx-rate.reader';
import { DepositCallbackController } from './deposit-callback.controller';
import { DepositCallbackService } from './deposit-callback.service';
import { DepositController } from './deposit.controller';
import { DepositExpiryService } from './deposit-expiry.service';
import { DepositInternalController } from './deposit-internal.controller';
import { DepositQuoteService } from './deposit-quote.service';
import { DepositStartService } from './deposit-start.service';

/**
 * The top-up page (F-092-o, F-092-i): the gateway list, the quote, and starting
 * the payment the quote described, and settling it when the bank sends the
 * payer back (F-092-j). `WalletModule` serves both ends: the free path credits
 * the wallet itself because no gateway will ever call back about it, and the
 * callback credits every other payment.
 *
 * `DepositCallbackController` is a second controller rather than a route on the
 * first because it is the only **public** one on this service — see its own
 * doc comment, and `app.module.ts` for the middleware that stands in for the
 * gate on it.
 *
 * `DepositInternalController` is a third, for the mirror-image reason: it is
 * the only **service-to-service** one, reached by `worker-service`'s expiry
 * tick (F-092-k) and by nothing from the edge at all.
 */
@Module({
  imports: [LocaleModule, CouponModule, GatewayModule, WalletModule],
  controllers: [DepositController, DepositCallbackController, DepositInternalController],
  providers: [DepositQuoteService, DepositStartService, DepositCallbackService, DepositExpiryService, FxRateReader],
  exports: [DepositQuoteService, DepositStartService, DepositCallbackService, DepositExpiryService],
})
export class DepositModule {}
