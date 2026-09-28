import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { EntitlementRefused, GrantService } from '../../entitlement/grant';
import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GrantLabelBody, grantLabelSchema, GrantListQuery, GrantsByLinesBody, grantListSchema, grantsByLinesSchema } from './grant-list.schema';

const E = BackendI18nKeys.errors.billing;

/**
 * A user's own Grants, listed (F-502-r): `GET /api/billing/gift/grants`.
 *
 * It lives beside the reissue route because it is what makes that route
 * reachable. A `free_grant` key is shown once and only hashed (D-35), and until
 * this list existed the reissue button (F-502-q) was reachable only while the
 * key was still on screen — a key lost after the modal closed had no way back.
 *
 * **Whose Grants comes from the gate's `X-User-Id`**, never from the query, so
 * there is no id here to authorise — the same shape as the financial page
 * (`wallet/wallet-history.controller.ts`). It raises no domain error either: a
 * user with no Grants is an empty page, not a 404. The only failures are a
 * malformed query (400, from the pipe) and the limiter (429).
 *
 * The capability is `subscriptionLink`, as on the reissue route: this reads no
 * money and what it lists are the `/sub` credentials' Grants, so it is open
 * exactly when `/sub` is — a suspended tenant's user still finds their services
 * until the grace ends.
 */
@Controller('billing/gift/grants')
export class GrantListController {
  constructor(private readonly grants: GrantService) {}

  @TenantCapability('subscriptionLink')
  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GRANT_LIST, identityOf(req).userId),
    configKey: 'GRANT_LIST_RATE_LIMIT',
    windowSec: 900,
  })
  list(@Query(new ZodValidationPipe(grantListSchema)) query: GrantListQuery, @Req() req: Request) {
    return this.grants.listForUser(identityOf(req).userId, query);
  }

  /**
   * The same list, narrowed to the Grants holding any of up to 20 pasted
   * config lines (F-307-p). A POST only because a line is a credential and
   * must not travel in a URL; it reads, so it answers 200. Its own bucket,
   * `GRANTS_BY_LINES` (user, 2026-09-26).
   */
  @TenantCapability('subscriptionLink')
  @Post('by-lines')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GRANTS_BY_LINES, identityOf(req).userId),
    configKey: 'GRANTS_BY_LINES_RATE_LIMIT',
    windowSec: 900,
  })
  byLines(@Body(new ZodValidationPipe(grantsByLinesSchema)) body: GrantsByLinesBody, @Req() req: Request) {
    return this.grants.listForUser(identityOf(req).userId, body);
  }

  /**
   * The buyer names one of their services, or clears the name (F-307-x).
   * Under `CONFIG_ACTION`, as a config's name is (F-307-g): one budget for
   * naming, a write and cheap to spend. Another user's Grant is the same 404
   * as a missing one.
   */
  @TenantCapability('subscriptionLink')
  @Put(':grantId/label')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.CONFIG_ACTION, identityOf(req).userId),
    configKey: 'CONFIG_ACTION_RATE_LIMIT',
    windowSec: 900,
  })
  async setLabel(
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Body(new ZodValidationPipe(grantLabelSchema)) body: GrantLabelBody,
    @Req() req: Request,
  ) {
    try {
      // The name as saved, in one spelling (F-307-o), not as sent.
      return { grantId, label: await this.grants.setLabel(identityOf(req).userId, grantId, body.label) };
    } catch (e) {
      if (e instanceof EntitlementRefused && e.reason === 'grant_not_found') {
        throw new NotFoundException({ i18nKey: E.grant.notFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      throw e;
    }
  }
}
