import { Module } from '@nestjs/common';

import { BillingClient } from '../billing/billing.client';
import { CurrencyPinsController } from './pins.controller';
import { CurrencyPinService } from './pins.service';

@Module({
  controllers: [CurrencyPinsController],
  providers: [CurrencyPinService, BillingClient],
})
export class CurrencyPinsModule {}
