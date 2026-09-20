import { Controller, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { EntitlementRefused, GrantService } from '../../entitlement/grant';
import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';

const E = BackendI18nKeys.errors.billing;

/**
 * Reissuing the subscription key of one Grant (F-502-p): `POST
 * /api/billing/gift/grants/:id/rotate-token`.
 *
 * A `free_grant` code shows its key once and stores only a hash (D-35), so a
 * key lost to a mis-click was lost for good — `GrantService.rotateToken` has
 * existed since F-026-e with nothing calling it. This is its caller, and it
 * lives beside the gift box because the box is where the key was first shown
 * and where the panel shows this one (F-502-q).
 *
 * **Ownership is the gate's user, never a field.** `rotateToken` checks it
 * again inside the transaction and answers another user's Grant exactly as a
 * missing one — the route must not tell them apart either, or it becomes a way
 * to ask whether a Grant id exists.
 *
 * The capability is `subscriptionLink` rather than `endUserDeposit`: this moves
 * no money, and what it mints is the `/sub` credential, so it should be open
 * exactly when `/sub` is. A suspended tenant's user may still recover a key
 * until the grace ends, and a terminated tenant's may not mint one for a link
 * that answers nothing.
 */
@Controller('billing/gift/grants')
export class GrantTokenController {
  constructor(private readonly grants: GrantService) {}

  @TenantCapability('subscriptionLink')
  @Post(':id/rotate-token')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GRANT_ROTATE_TOKEN, identityOf(req).userId),
    configKey: 'GRANT_ROTATE_TOKEN_RATE_LIMIT',
    windowSec: 900,
  })
  async rotate(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const { userId } = identityOf(req);
    try {
      // Shown this once, like the key a redemption answers: only its hash is kept.
      return { grantId: id, subscriptionKey: await this.grants.rotateTokenForUser(id, userId) };
    } catch (e) {
      if (e instanceof EntitlementRefused && e.reason === 'grant_not_found') {
        throw new NotFoundException({ i18nKey: E.grant.notFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      throw e;
    }
  }
}
