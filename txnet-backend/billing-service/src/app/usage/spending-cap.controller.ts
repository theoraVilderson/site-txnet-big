import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { SpendingCapRefused, SpendingCapService } from './spending-cap';
import { SpendingCapBody, spendingCapSchema } from './spending-cap.schema';

const E = BackendI18nKeys.errors.billing;

const LIMIT = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SPENDING_CAP, identityOf(req).userId),
  configKey: 'SPENDING_CAP_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * The owner's spending cap on one of their Grants (F-118-i, ADR-0105 (9)):
 * read it, set or change it, remove it. Whose Grant is the gate's
 * `X-User-Id`; another user's Grant is the same 404 as a missing one.
 */
@Controller('billing/traffic')
export class SpendingCapController {
  constructor(private readonly caps: SpendingCapService) {}

  /** `{ grantId, cap: null }` when none is set. */
  @Get('grants/:grantId/cap')
  @RateLimit(LIMIT)
  async get(@Param('grantId', ParseUUIDPipe) grantId: string, @Req() req: Request) {
    return { grantId, cap: await this.refusing(() => this.caps.get(identityOf(req).userId, grantId)) };
  }

  @TenantCapability('account')
  @Put('grants/:grantId/cap')
  @RateLimit(LIMIT)
  async set(
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Body(new ZodValidationPipe(spendingCapSchema)) body: SpendingCapBody,
    @Req() req: Request,
  ) {
    return { grantId, cap: await this.refusing(() => this.caps.set(identityOf(req).userId, grantId, { label: body.label, amount: body.amount, period: body.period })) };
  }

  @TenantCapability('account')
  @Delete('grants/:grantId/cap')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RateLimit(LIMIT)
  async remove(@Param('grantId', ParseUUIDPipe) grantId: string, @Req() req: Request): Promise<void> {
    await this.refusing(() => this.caps.remove(identityOf(req).userId, grantId));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      // A user with no wallet has no Grant to fund either: the same answer.
      if (e instanceof SpendingCapRefused) {
        throw new NotFoundException({ i18nKey: E.grant.notFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      throw e;
    }
  }
}
