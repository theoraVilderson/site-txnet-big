import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../../auth/auth.guard';
import { RateLimit } from '../../auth/decorators/rate-limit.decorator';
import type { AuthClaims } from '../../auth/token.service';
import { UiPreferencesService } from './ui-preferences.service';
import { AllowRestricted } from '../../auth/decorators/allow-restricted.decorator';

const LIMIT = {
  key: (req: Request & { user?: AuthClaims }) => rateLimitBucketKey(RateLimitBucket.ME_UI_PREFERENCES, req?.user?.sub ?? req?.ip),
  configKey: 'ME_UI_PREFERENCES_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * A person's display preferences (UX-1-k, `panel-web/contract.ux.md` P1–P3):
 * motion level, dashboard layout, pins, sidebar. Owned by `governance`, served
 * here beside `/auth/me`. The read is a `read`; the write is `account` — a
 * person changing their own account, never `staffWrite`, the default a
 * mutating route would otherwise get.
 *
 * The body is validated in the service, not by a pipe: an unknown key must
 * answer `unknown_preference`, which a strict schema would fold into a
 * generic validation failure.
 */
// The panel's own boot reads, so a restricted account's screen loads (ADR-0133).
@AllowRestricted()
@Controller('auth/me/ui-preferences')
export class UiPreferencesController {
  constructor(private readonly preferences: UiPreferencesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit(LIMIT)
  read(@Req() req: Request) {
    return this.preferences.read(claimsOf(req));
  }

  @TenantCapability('account')
  @Patch()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit(LIMIT)
  save(@Body() body: unknown, @Req() req: Request) {
    return this.preferences.save(claimsOf(req), body);
  }
}

function claimsOf(req: Request): AuthClaims {
  return (req as unknown as { user: AuthClaims }).user;
}
