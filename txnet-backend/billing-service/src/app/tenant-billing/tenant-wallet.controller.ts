import { Controller, Get, Query, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { refusal } from './tenant-topup.controller';
import { TenantWalletQueryBody, tenantWalletSchema } from './tenant-wallet.schema';
import { TenantWalletService } from './tenant-wallet.service';

/**
 * A reseller's own billing wallet, read (F-019-d, D-41):
 * `GET /api/billing/tenant-wallet`. Behind the gate; the user and the reseller
 * come from its headers, never the query. Limited in the wallet history's
 * bucket, per user — the same act, reading a money list.
 */
@Controller('billing/tenant-wallet')
export class TenantWalletController {
  constructor(private readonly wallets: TenantWalletService) {}

  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.WALLET_HISTORY, identityOf(req).userId),
    configKey: 'WALLET_HISTORY_RATE_LIMIT',
    windowSec: 900,
  })
  async history(@Query(new ZodValidationPipe(tenantWalletSchema)) query: TenantWalletQueryBody, @Req() req: Request) {
    try {
      return await this.wallets.history(identityOf(req), query);
    } catch (e) {
      throw refusal(e);
    }
  }
}
