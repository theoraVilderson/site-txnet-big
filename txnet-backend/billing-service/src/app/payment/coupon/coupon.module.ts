import { Module } from '@nestjs/common';

import { CouponReservationService } from './coupon-reservation';
import { CouponValidationService } from './coupon-validation';

/**
 * The coupon engine: validation (F-092-g) and reservation (F-092-h). F-092-o
 * quotes with it and F-092-i holds what it applied; F-092-j and F-092-k settle
 * those holds.
 */
@Module({
  providers: [CouponValidationService, CouponReservationService],
  exports: [CouponValidationService, CouponReservationService],
})
export class CouponModule {}
