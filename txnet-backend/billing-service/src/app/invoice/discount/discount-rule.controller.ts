import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { CouponPermissionGuard } from '../../payment/coupon-admin/coupon-permission.guard';
import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import {
  DiscountRuleActor,
  DiscountRuleAdminService,
  DiscountRuleInput,
  DiscountRulePatch,
  DiscountRuleRefused,
  DiscountRuleRejection,
} from './discount-rule-admin.service';
import { CreateDiscountRuleBody, UpdateDiscountRuleBody, createDiscountRuleSchema, updateDiscountRuleSchema } from './discount-rule.schema';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const DISCOUNT_RULE_REFUSAL_STATUS: Record<DiscountRuleRejection, 400 | 404> = {
  rule_not_found: 404,
  target_not_found: 404,
  user_out_of_scope: 400,
  invalid_value: 400,
  invalid_window: 400,
  one_target: 400,
  named_needs_users: 400,
  one_audience: 400,
  group_not_found: 404,
};

// The coupon admin's budgets: the same admins, the same family of writes (ADR-0087).
const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.COUPON_ADMIN_READ, identityOf(req).userId),
  configKey: 'COUPON_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.COUPON_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'COUPON_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * Discounts with no code (F-114-h, D-45): `/api/billing/discount-rules`.
 * Behind `coupon.manage` — the same admins who run coupons run these — and
 * confined to the caller's own tenant by RLS (`DiscountRuleAdminService`).
 * No delete: a rule an invoice names is switched off (`isActive: false`).
 */
@Controller('billing/discount-rules')
@UseGuards(CouponPermissionGuard)
export class DiscountRuleController {
  constructor(private readonly rules: DiscountRuleAdminService) {}

  private actor(req: Request, ip: string): DiscountRuleActor {
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId, ip };
  }

  @Get()
  @RateLimit(READ)
  async list(@Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.rules.list(this.actor(req, ip)));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async create(@Body(new ZodValidationPipe(createDiscountRuleSchema)) body: CreateDiscountRuleBody, @Req() req: Request, @Ip() ip: string) {
    // The schema requires name, kind, value and startsAt; the cast is for this
    // project's non-strict tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.rules.create(this.actor(req, ip), body as DiscountRuleInput));
  }

  @Patch(':id')
  @RateLimit(WRITE)
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateDiscountRuleSchema)) body: UpdateDiscountRuleBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.rules.update(this.actor(req, ip), id, body as DiscountRulePatch));
  }

  /** One place that turns a refusal into a status; the reason travels in the body for the panel to translate. */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof DiscountRuleRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      if (DISCOUNT_RULE_REFUSAL_STATUS[e.reason] === 404) throw new NotFoundException(payload);
      throw new BadRequestException(payload);
    }
  }
}
