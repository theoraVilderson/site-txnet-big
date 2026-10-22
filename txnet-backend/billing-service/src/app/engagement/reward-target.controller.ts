import { Body, ConflictException, Controller, Get, NotFoundException, Put, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';
import { z } from 'zod';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { RewardTargetRefused, RewardTargetRejection, RewardTargetService } from './reward-target.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const REWARD_TARGET_REFUSAL_STATUS: Record<RewardTargetRejection, 404 | 409> = {
  grant_not_found: 404,
  grant_not_eligible: 409,
};

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.REWARD_TARGET_READ, identityOf(req).userId),
  configKey: 'REWARD_TARGET_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.REWARD_TARGET_WRITE, identityOf(req).userId),
  configKey: 'REWARD_TARGET_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/** `grantId: null` is automatic: the Grant that runs longest. */
export const rewardTargetSchema = z.object({ grantId: z.string().uuid({ message: 'grantId must be a uuid' }).nullable() }).strict();
type RewardTargetBody = z.infer<typeof rewardTargetSchema>;

/**
 * A user's prize service (F-707-r): `/api/billing/reward-target`. Any signed-in
 * user; whose choice is the gate's `X-User-Id`, never the body. Both routes
 * answer the same view, so a screen redraws from the write's answer.
 */
@Controller('billing/reward-target')
export class RewardTargetController {
  constructor(private readonly targets: RewardTargetService) {}

  @Get()
  @RateLimit(READ)
  view(@Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    return this.targets.view({ userId, tenantId });
  }

  @Put()
  @RateLimit(WRITE)
  async choose(@Body(new ZodValidationPipe(rewardTargetSchema)) body: RewardTargetBody, @Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    try {
      return await this.targets.choose({ userId, tenantId }, body.grantId);
    } catch (e) {
      if (!(e instanceof RewardTargetRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      if (REWARD_TARGET_REFUSAL_STATUS[e.reason] === 404) throw new NotFoundException(payload);
      throw new ConflictException(payload);
    }
  }
}
