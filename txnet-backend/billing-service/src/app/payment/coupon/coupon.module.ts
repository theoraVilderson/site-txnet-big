import { Module } from '@nestjs/common';

import { AiOfferCouponController } from './ai-offer-coupon.controller';
import { AiOfferCouponService } from './ai-offer-coupon';
import { CouponReservationService } from './coupon-reservation';
import { CouponValidationService } from './coupon-validation';
import { FxRateReader } from '../pricing/fx-rate.reader';

/**
 * The coupon engine: validation (F-092-g) and reservation (F-092-h). F-092-o
 * quotes with it and F-092-i holds what it applied; F-092-j and F-092-k settle
 * those holds. F-038-f3 issues an AI offer's personal coupon.
 */
@Module({
  // FxRateReader: a coupon in another currency than the order is converted at the live rate (F-116-h6).
  providers: [CouponValidationService, CouponReservationService, FxRateReader, AiOfferCouponService],
  controllers: [AiOfferCouponController],
  exports: [CouponValidationService, CouponReservationService],
})
export class CouponModule {}
