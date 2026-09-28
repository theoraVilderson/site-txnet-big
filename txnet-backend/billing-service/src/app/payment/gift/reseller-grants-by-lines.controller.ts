import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GrantsByLinesBody, grantsByLinesSchema } from './grant-list.schema';
import { actorOf, resellerRefusal } from './reseller-user-grants.controller';
import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

/**
 * An admin finds a service by a pasted config line or `/sub` link across the
 * reseller's own users (F-311-t, spec F-307): `POST
 * /api/billing/tenants/:tenantId/grants/by-lines`. Support is handed a link,
 * not a phone number, so no user is in the path — the paste names them, and
 * each row answers its `userId` for the user sheet (F-311-f).
 *
 * The owner's body and matcher (F-307-p, F-307-r), unchanged: **a POST body,
 * never a query string**, because a line is a credential. The paste's bucket,
 * `GRANTS_BY_LINES`, per caller: one scan reads every live config of the
 * reseller, and the look-ups on the rows it finds spend the reads' own budget.
 * No permission guard: `ResellerAccess` is the door, as on every
 * reseller-named surface.
 */
@Controller('billing/tenants/:tenantId/grants')
export class ResellerGrantsByLinesController {
  constructor(private readonly service: ResellerUserGrantsService) {}

  @Post('by-lines')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GRANTS_BY_LINES, identityOf(req).userId),
    configKey: 'GRANTS_BY_LINES_RATE_LIMIT',
    windowSec: 900,
  })
  async byLines(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(grantsByLinesSchema)) body: GrantsByLinesBody,
    @Req() req: Request,
  ) {
    try {
      return await this.service.findByLines(actorOf(req), tenantId, body);
    } catch (e) {
      if (e instanceof ResellerUserGrantsRefused) throw resellerRefusal(e);
      throw e;
    }
  }
}
