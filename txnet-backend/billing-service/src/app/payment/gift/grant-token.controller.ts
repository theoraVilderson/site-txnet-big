import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { SubscriptionLinkService } from './subscription-link.service';

/**
 * A Grant's subscription link (F-114-e-b, ADR-0085): `GET
 * /api/billing/gift/grants/:id/subscription-link` answers it as often as
 * asked, and `POST .../rotate-token` — "reset link" — replaces it for a link
 * that leaked and answers the new one.
 *
 * Reset was built as "reissue key" (F-502-p), when a key was shown once and
 * only hashed; since the token is kept sealed it is a security action, not
 * recovery. Until the panel stops showing a key (F-114-e-c) its answer still
 * carries `subscriptionKey` beside the URL.
 *
 * **Ownership is the gate's user, never a field**, and another user's Grant is
 * answered exactly as a missing one (`SubscriptionLinkService`).
 *
 * The capability is `subscriptionLink` on both: neither moves money, and what
 * they answer is the `/sub` credential, so they are open exactly when `/sub`
 * is — a suspended tenant's user until the grace ends, a terminated tenant's
 * never.
 */
@Controller('billing/gift/grants')
export class GrantTokenController {
  constructor(private readonly links: SubscriptionLinkService) {}

  @TenantCapability('subscriptionLink')
  @Get(':id/subscription-link')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.SUBSCRIPTION_LINK, identityOf(req).userId),
    configKey: 'SUBSCRIPTION_LINK_RATE_LIMIT',
    windowSec: 900,
  })
  async link(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return { grantId: id, subscriptionUrl: await this.links.linkFor(id, identityOf(req).userId) };
  }

  @TenantCapability('subscriptionLink')
  @Post(':id/rotate-token')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GRANT_ROTATE_TOKEN, identityOf(req).userId),
    configKey: 'GRANT_ROTATE_TOKEN_RATE_LIMIT',
    windowSec: 900,
  })
  async rotate(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const subscriptionUrl = await this.links.reset(id, identityOf(req).userId);
    // `subscriptionKey` is the last path segment, for the panel that still shows it (F-114-e-c drops it).
    return { grantId: id, subscriptionUrl, subscriptionKey: subscriptionUrl.slice(subscriptionUrl.lastIndexOf('/') + 1) };
  }
}
