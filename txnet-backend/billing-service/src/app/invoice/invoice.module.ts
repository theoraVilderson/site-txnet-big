import { Module } from '@nestjs/common';

import { LocaleModule } from '../locale/locale.module';
import { CouponModule } from '../payment/coupon/coupon.module';
import { InvoiceExpiryService } from './invoice-expiry.service';
import { InvoiceInternalController } from './invoice-internal.controller';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';

/** Buying a catalog product: the invoice (F-111-a) and its clock. Paying it is F-111-b. */
@Module({
  imports: [LocaleModule, CouponModule],
  controllers: [InvoiceController, InvoiceInternalController],
  providers: [InvoiceService, InvoiceExpiryService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
