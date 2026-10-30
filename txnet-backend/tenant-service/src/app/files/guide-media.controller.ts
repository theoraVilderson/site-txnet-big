import { Controller, Get, Inject, NotFoundException, Req, Res, UseGuards } from '@nestjs/common';
import {
  type GuideMediaAudience,
  type ObjectDriver,
  PublicRoute,
  ServiceOnlyGuard,
  TenantContext,
  guideMediaType,
  parseObjectKey,
  publicPath,
} from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import { keyOf } from './files.controller';
import { OBJECT_DRIVER } from './object-driver';
import { PlatformTenant } from './platform-tenant';

/** `GET /api/public/tenant/media/<key>`: a guide video, for a `<video>` on the panel (F-018-m2-b). */
export const GUIDE_MEDIA_PATH = publicPath('tenant', 'media');

/** How long a signed bucket URL lives: long enough to watch a 50 MiB video with pauses and seeks. */
export const GUIDE_MEDIA_URL_TTL_SEC = 60 * 60;
/** The redirect is kept well inside that, so a cached one never names a dead URL. */
export const GUIDE_MEDIA_REDIRECT_MAX_AGE_SEC = 5 * 60;

/**
 * Answers a redirect to a short signed URL of the bucket, never the bytes
 * (ADR-0116 point 3, ADR-0118): Range, seeks and long downloads are the
 * store's, and no service holds a viewer's connection. A 404 when the key's
 * shape refuses it for this audience or the driver cannot sign (the volume).
 */
async function redirectToStore(driver: ObjectDriver, key: string, audience: GuideMediaAudience, res: Response): Promise<void> {
  const contentType = guideMediaType(key, audience);
  if (!contentType || !driver.signedReadUrl) throw new NotFoundException();
  const url = await driver.signedReadUrl(key, { expiresInSec: GUIDE_MEDIA_URL_TTL_SEC, contentType });
  res.set({ 'Cache-Control': `private, max-age=${GUIDE_MEDIA_REDIRECT_MAX_AGE_SEC}` });
  res.redirect(302, url);
}

/**
 * Guide videos for the panel's `<video>`, on the Host's own tenant's keys and
 * the platform's, which every reseller inherits (object-storage rule 8). No
 * row is read: the key's shape is the whole check, as nginx's `location` was.
 */
@Controller(GUIDE_MEDIA_PATH)
export class GuideMediaController {
  constructor(
    @Inject(OBJECT_DRIVER) private readonly driver: ObjectDriver,
    private readonly platform: PlatformTenant,
  ) {}

  @Get('*key')
  @PublicRoute({ doors: ['panel', 'assets'] })
  async serve(@Req() req: Request, @Res() res: Response): Promise<void> {
    const key = keyOf(req);
    const owner = parseObjectKey(key)?.tenantId;
    const isHosts = owner === TenantContext.current('guide media').id || owner === (await this.platform.id());
    if (!isHosts) throw new NotFoundException();
    await redirectToStore(this.driver, key, 'browser', res);
  }
}

/**
 * The bot's guide pictures and videos (F-414-f), by key, with the service
 * token: `internal/*` is not routed by Traefik and has no Host. Guides are
 * public, so the tenant in the key is the only one asked about.
 */
@Controller('internal/guide-media')
@UseGuards(ServiceOnlyGuard)
export class GuideMediaInternalController {
  constructor(@Inject(OBJECT_DRIVER) private readonly driver: ObjectDriver) {}

  @Get('*key')
  async serve(@Req() req: Request, @Res() res: Response): Promise<void> {
    await redirectToStore(this.driver, keyOf(req), 'bot', res);
  }
}
