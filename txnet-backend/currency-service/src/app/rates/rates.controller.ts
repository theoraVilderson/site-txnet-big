import { Controller, Get } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { CurrencyRate, CurrencyRatesService } from './rates.service';

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.CURRENCY_READ, identityOf(req).userId),
  configKey: 'CURRENCY_READ_RATE_LIMIT' as const,
  windowSec: 60,
};

/**
 * `GET /api/currency/rates` (F-116-k). Any signed-in caller: a rate is not a
 * secret, and every panel screen that shows money in another currency needs it.
 */
@Controller('currency/rates')
export class CurrencyRatesController {
  constructor(private readonly rates: CurrencyRatesService) {}

  @Get()
  @RateLimit(READ)
  list(): Promise<CurrencyRate[]> {
    return this.rates.list();
  }
}
