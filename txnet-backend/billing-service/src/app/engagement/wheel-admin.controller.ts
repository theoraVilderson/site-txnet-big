import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpStatus, Ip, NotFoundException, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { EngagementPermissionGuard } from './engagement-permission.guard';
import { WheelVersionBody, wheelVersionSchema } from './wheel-admin.schema';
import { WheelActor, WheelAdminRefused, WheelAdminRejection, WheelAdminService, WheelVersionInput } from './wheel-admin.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const WHEEL_ADMIN_REFUSAL_STATUS: Record<WheelAdminRejection, 400 | 404 | 409> = {
  invalid_prize: 400,
  invalid_amount: 400,
  expected_cost_over_cap: 400,
  prize_cost_over_cap: 400,
  coupon_template_not_found: 404,
  variant_not_found: 404,
  group_not_found: 404,
  version_not_found: 404,
  version_taken: 409,
};

export const ENGAGEMENT_ADMIN_READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.ENGAGEMENT_ADMIN_READ, identityOf(req).userId),
  configKey: 'ENGAGEMENT_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.ENGAGEMENT_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'ENGAGEMENT_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * A tenant's wheel settings (F-707-c, ADR-0111 point 4):
 * `/api/billing/engagement/wheel`. Behind `engagement.manage`, confined to the
 * caller's own tenant by RLS (`WheelAdminService`). No update and no delete: a
 * save is a new version from the tenant's next day.
 */
@Controller('billing/engagement/wheel')
@UseGuards(EngagementPermissionGuard)
export class WheelAdminController {
  constructor(private readonly wheel: WheelAdminService) {}

  private actor(req: Request, ip: string): WheelActor {
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId, ip };
  }

  @Get()
  @RateLimit(ENGAGEMENT_ADMIN_READ)
  async state(@Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.wheel.state(this.actor(req, ip)));
  }

  @Post('versions')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async save(@Body(new ZodValidationPipe(wheelVersionSchema)) body: WheelVersionBody, @Req() req: Request, @Ip() ip: string) {
    // The cast is for this project's non-strict tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.wheel.save(this.actor(req, ip), body as WheelVersionInput));
  }

  @Get('versions/:version')
  @RateLimit(ENGAGEMENT_ADMIN_READ)
  async version(@Param('version', new ParseIntPipe()) version: number, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.wheel.version(this.actor(req, ip), version));
  }

  /** One place that turns a refusal into a status; the reason travels in the body for the panel to translate. */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof WheelAdminRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (WHEEL_ADMIN_REFUSAL_STATUS[e.reason]) {
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
