import { Body, ConflictException, Controller, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { EntitlementRefused } from '../../entitlement/grant';
import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GrantBulkBody, grantBulkSchema } from './grant-bulk.schema';
import { actorOf, resellerRefusal } from './reseller-user-grants.controller';
import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

/**
 * An admin acts on many of its users' Grants at once (F-311-u, spec F-311):
 * `POST /api/billing/tenants/:tenantId/grants/bulk` — freeze, unfreeze, days,
 * traffic, reset, gift, speed, devices over 1..50 Grants, one outcome per
 * Grant, always **200** once the door lets it in; the refusals of the door are
 * the other reseller routes' (`resellerRefusal`). A repeated `requestId`
 * answers the first call's outcomes; the same id with another body is **409**
 * `request_reused` (F-311-u1).
 *
 * No user in the path: the Grants may be many users', and each is fenced by
 * the reseller's tenant. The single-Grant writes' bucket,
 * `RESELLER_USER_CONFIG_ACTION`, per request — as the config actions spend it
 * for 1..50 configs. No permission guard: `ResellerAccess` is the door.
 */
@Controller('billing/tenants/:tenantId/grants')
export class ResellerGrantsBulkController {
  constructor(private readonly service: ResellerUserGrantsService) {}

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_CONFIG_ACTION, identityOf(req).userId),
    configKey: 'RESELLER_USER_CONFIG_ACTION_RATE_LIMIT',
    windowSec: 900,
  })
  async bulk(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(grantBulkSchema)) body: GrantBulkBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    try {
      return { action: body.action, results: await this.service.bulk({ ...actorOf(req), ip }, tenantId, body) };
    } catch (e) {
      if (e instanceof ResellerUserGrantsRefused) throw resellerRefusal(e);
      if (e instanceof EntitlementRefused && e.reason === 'request_reused') throw new ConflictException({ reason: e.reason, message: e.message });
      throw e;
    }
  }
}
