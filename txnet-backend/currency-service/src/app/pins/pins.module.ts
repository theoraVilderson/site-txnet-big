import { Module } from '@nestjs/common';

import { CurrencyPinsController } from './pins.controller';
import { CurrencyPinService } from './pins.service';

@Module({
  controllers: [CurrencyPinsController],
  providers: [CurrencyPinService],
})
export class CurrencyPinsModule {}
