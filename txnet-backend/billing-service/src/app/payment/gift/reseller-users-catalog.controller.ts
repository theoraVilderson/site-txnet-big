import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { actorOf, resellerRefusal } from './reseller-user-grants.controller';
import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

/**
 * The catalog the users pages name (F-311-ab1, D-57): `GET
 * /api/billing/tenants/:tenantId/users-catalog` -> `{products}`, what an admin
 * issues and what a bulk filter picks by product. The users-admin door
 * (`runIncludingPlatform`, `read`), not the catalog's: a support admin who
 * manages users is not thereby one who edits prices. It spends the users
 * reads' bucket, as every other read those pages make. `?userId=` is the
 * user an issue is for: a product whose audience leaves them out is left out
 * (PT-1-b), so the dialog never offers an issue that answers `not_in_audience`.
 */
@Controller('billing/tenants/:tenantId/users-catalog')
export class ResellerUsersCatalogController {
  constructor(private readonly service: ResellerUserGrantsService) {}

  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_GRANTS_READ, identityOf(req).userId),
    configKey: 'RESELLER_USER_GRANTS_READ_RATE_LIMIT',
    windowSec: 900,
  })
  async catalog(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Req() req: Request,
    @Query('userId', new ParseUUIDPipe({ optional: true })) userId?: string,
  ) {
    try {
      return { products: await this.service.catalog(actorOf(req), tenantId, userId) };
    } catch (e) {
      if (e instanceof ResellerUserGrantsRefused) throw resellerRefusal(e);
      throw e;
    }
  }
}
