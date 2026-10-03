import { ConflictException, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { LotteryEntryRefused, LotteryEntryRejection, LotteryEntryService } from './lottery-entry.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const LOTTERY_ENTRY_REFUSAL_STATUS: Record<LotteryEntryRejection, 404 | 409> = {
  lottery_not_found: 404,
  not_opt_in: 409,
  closed: 409,
};

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.LOTTERY_READ, identityOf(req).userId),
  configKey: 'LOTTERY_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const ENTRY = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.LOTTERY_ENTRY, identityOf(req).userId),
  configKey: 'LOTTERY_ENTRY_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * A user's lotteries (F-707-j, ADR-0111 point 6): `/api/billing/lotteries`.
 * Any signed-in user; the lottery's group decides who sees it. Joining and
 * leaving are idempotent: a repeat answers `replay: true`. Free — nothing
 * here takes money.
 */
@Controller('billing/lotteries')
export class LotteryController {
  constructor(private readonly lotteries: LotteryEntryService) {}

  @Get()
  @RateLimit(READ)
  async list(@Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    return this.lotteries.list({ userId, tenantId });
  }

  @Post(':id/entry')
  @HttpCode(HttpStatus.OK)
  @RateLimit(ENTRY)
  async join(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    return this.refusing(() => this.lotteries.join({ userId, tenantId }, id));
  }

  @Delete(':id/entry')
  @HttpCode(HttpStatus.OK)
  @RateLimit(ENTRY)
  async leave(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    return this.refusing(() => this.lotteries.leave({ userId, tenantId }, id));
  }

  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof LotteryEntryRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      if (LOTTERY_ENTRY_REFUSAL_STATUS[e.reason] === 404) throw new NotFoundException(payload);
      throw new ConflictException(payload);
    }
  }
}
