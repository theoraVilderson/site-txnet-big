import { Module } from '@nestjs/common';

import { LocaleModule } from '../../locale/locale.module';
import { CouponModule } from '../coupon/coupon.module';
import { GatewayModule } from '../gateway/gateway.module';
import { DepositController } from './deposit.controller';
import { DepositQuoteService } from './deposit-quote.service';

/**
 * The top-up page's read side (F-092-o): the gateway list and the quote. The
 * first billing routes; F-092-i adds starting a payment beside them.
 */
@Module({
  imports: [LocaleModule, CouponModule, GatewayModule],
  controllers: [DepositController],
  providers: [DepositQuoteService],
  exports: [DepositQuoteService],
})
export class DepositModule {}
