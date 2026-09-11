import { Module } from '@nestjs/common';

import { CouponReservationService } from './coupon-reservation';
import { CouponValidationService } from './coupon-validation';

/**
 * The coupon engine: validation (F-092-g) and reservation (F-092-h). No route
 * calls it yet — F-092-o quotes with it, F-092-i reserves, F-092-j and F-092-k
 * settle.
 */
@Module({
  providers: [CouponValidationService, CouponReservationService],
  exports: [CouponValidationService, CouponReservationService],
})
export class CouponModule {}
