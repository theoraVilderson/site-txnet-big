import { Module } from '@nestjs/common';

import { CurrencyRatesController } from './rates.controller';
import { CurrencyRatesService } from './rates.service';

@Module({
  controllers: [CurrencyRatesController],
  providers: [CurrencyRatesService],
})
export class CurrencyRatesModule {}
