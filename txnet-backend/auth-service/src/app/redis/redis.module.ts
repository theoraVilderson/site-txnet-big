import { Global, Module } from '@nestjs/common';
import { SEND_RATE_STORE } from '@txnet-backend/messenger';

import { RedisService } from './redis.service';

/**
 * `SEND_RATE_STORE` is bound here, beside the client itself, because this
 * app's sends spend the same per-bot ceiling a campaign does (F-313-c,
 * ADR-0066). They are answers to a person waiting, so they are counted and
 * never refused — what the binding buys is that the bulk sender's budget is
 * true, and it is the one that yields.
 */
@Global()
@Module({
  providers: [
    RedisService,
    { provide: SEND_RATE_STORE, useExisting: RedisService },
  ],
  exports: [RedisService, SEND_RATE_STORE],
})
export class RedisModule {}
