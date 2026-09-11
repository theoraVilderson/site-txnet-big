import { Module } from '@nestjs/common';

import { CouponValidationService } from './coupon-validation';

/**
 * The coupon engine (F-092-g). No route calls it yet — F-092-o quotes with it,
 * F-092-h reserves what it applied.
 */
@Module({
  providers: [CouponValidationService],
  exports: [CouponValidationService],
})
export class CouponModule {}
