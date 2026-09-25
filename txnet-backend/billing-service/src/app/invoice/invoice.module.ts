import { Module } from '@nestjs/common';

import { EntitlementModule } from '../entitlement/entitlement.module';
import { LocaleModule } from '../locale/locale.module';
import { CouponModule } from '../payment/coupon/coupon.module';
import { WalletModule } from '../wallet/wallet.module';
import { InvoiceExpiryService } from './invoice-expiry.service';
import { InvoiceInternalController } from './invoice-internal.controller';
import { InvoicePaymentService } from './invoice-payment.service';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';

/** Buying a catalog product: the invoice (F-111-a), its clock, and paying it from the wallet (F-111-b). */
@Module({
  imports: [LocaleModule, CouponModule, WalletModule, EntitlementModule],
  controllers: [InvoiceController, InvoiceInternalController],
  providers: [InvoiceService, InvoiceExpiryService, InvoicePaymentService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
