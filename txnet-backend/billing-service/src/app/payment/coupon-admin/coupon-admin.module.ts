import { Module } from '@nestjs/common';

import { CouponAdminController } from './coupon-admin.controller';
import { CouponAdminService } from './coupon-admin.service';
import { CouponBatchService } from './coupon-batch.service';
import { CouponUsageService } from './coupon-usage.service';

/**
 * Coupon and gift-code management (F-502-c..f, D-33).
 *
 * No imports: `PrismaModule` is `@Global()`. It does not import `CouponModule`
 * — that is the engine a payer's quote runs through, and nothing here prices a
 * payment.
 */
@Module({
  controllers: [CouponAdminController],
  providers: [CouponAdminService, CouponBatchService, CouponUsageService],
})
export class CouponAdminModule {}
