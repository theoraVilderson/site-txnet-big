import { Module } from '@nestjs/common';

import { EntitlementModule } from '../entitlement/entitlement.module';
import { LocaleModule } from '../locale/locale.module';
import { CouponModule } from '../payment/coupon/coupon.module';
import { WalletModule } from '../wallet/wallet.module';
import { DiscountRuleAdminService } from './discount/discount-rule-admin.service';
import { DiscountRuleController } from './discount/discount-rule.controller';
import { InvoiceExpiryService } from './invoice-expiry.service';
import { InvoiceInternalController } from './invoice-internal.controller';
import { InvoicePaymentService } from './invoice-payment.service';
import { InvoiceController, OffersController } from './invoice.controller';
import { InvoiceService } from './invoice.service';

/** Buying a catalog product: the invoice (F-111-a), its clock, paying it from the wallet (F-111-b), what the shop lists and reads back (F-111-e), and the discounts with no code it is priced with (F-114-h). */
@Module({
  imports: [LocaleModule, CouponModule, WalletModule, EntitlementModule],
  controllers: [InvoiceController, OffersController, InvoiceInternalController, DiscountRuleController],
  providers: [InvoiceService, InvoiceExpiryService, InvoicePaymentService, DiscountRuleAdminService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
