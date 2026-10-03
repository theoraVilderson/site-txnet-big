import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpStatus, NotFoundException, Post, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';
import { z } from 'zod';

import { fingerprintSourceOf } from '../fraud/device-fingerprint';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { WheelSpinRefused, WheelSpinRejection, WheelSpinService } from './wheel-spin.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const WHEEL_SPIN_REFUSAL_STATUS: Record<WheelSpinRejection, 400 | 404 | 409> = {
  no_wheel: 404,
  no_fingerprint: 400,
  spin_in_progress: 409,
};

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.WHEEL_READ, identityOf(req).userId),
  configKey: 'WHEEL_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const SPIN = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.WHEEL_SPIN, identityOf(req).userId),
  configKey: 'WHEEL_SPIN_RATE_LIMIT' as const,
  windowSec: 900,
};

/** `requestId` is the client's key for one tap: a retry with it answers the same spin. */
export const spinSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    grantId: z.string().uuid({ message: 'grantId must be a uuid' }).optional(),
  })
  .strict();
type SpinBody = z.infer<typeof spinSchema>;

/**
 * A user's wheel (F-707-d, ADR-0111 points 3, 4): `/api/billing/wheel`. Any
 * signed-in user of the tenant; the wheel decides who may spin.
 *
 * A refused spin is an answer, not an error: it is recorded (invariant 2) and
 * comes back `200` with `status` and `refusalReason`, so the panel and the
 * bot say why. Only a spin that records nothing is a 4xx.
 */
@Controller('billing/wheel')
export class WheelController {
  constructor(private readonly wheel: WheelSpinService) {}

  @Get()
  @RateLimit(READ)
  async view(@Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    return this.refusing(() => this.wheel.view({ userId, tenantId }, fingerprintSourceOf(req)));
  }

  /** The caller's own attempts, newest first (F-707-g); a won coupon named by its code. */
  @Get('history')
  @RateLimit(READ)
  async history(@Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    return this.wheel.history({ userId, tenantId });
  }

  @Post('spin')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SPIN)
  async spin(@Body(new ZodValidationPipe(spinSchema)) body: SpinBody, @Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    return this.refusing(() => this.wheel.spin({ userId, tenantId }, { requestId: body.requestId as string, grantId: body.grantId, source: fingerprintSourceOf(req) }));
  }

  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof WheelSpinRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (WHEEL_SPIN_REFUSAL_STATUS[e.reason]) {
        case 404:
          throw new NotFoundException(payload);
        case 409:
          throw new ConflictException(payload);
        default:
          throw new BadRequestException(payload);
      }
    }
  }
}
