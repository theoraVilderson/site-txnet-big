import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, runWithTenant } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { guideInternalListQuerySchema, guideInternalOneQuerySchema, guideKeySchema } from './guide-public.schema';
import { GuidePlacementQuery, GuideReader, ResolvedGuide } from './guide-reader';

/**
 * A tenant's guides for the bot (F-414-f): the same resolver, cache and
 * generations as the panel's public route (`GuideReader`, F-414-b), named by
 * tenant instead of by Host — a bot knows its tenant (its integration's) and
 * not which panel domain a reseller serves on. `internal/*` is outside the
 * Host and identity middleware and Traefik does not route it; only a caller
 * with the service token reaches it. Guides are public, so nothing else is
 * asked: this answers exactly what that tenant's panel shows a stranger.
 */
@Controller('internal/guides')
@UseGuards(ServiceOnlyGuard)
export class GuideInternalController {
  constructor(private readonly reader: GuideReader) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(guideInternalListQuerySchema)) q: GuidePlacementQuery & { tenantId: string },
  ): Promise<{ guides: ResolvedGuide[] }> {
    const { tenantId, ...placement } = q;
    return (await runWithTenant({ id: tenantId }, () => this.reader.list(tenantId, placement, languageOf(req)))).body;
  }

  @Get(':key')
  async one(
    @Req() req: Request,
    @Param('key', new ZodValidationPipe(guideKeySchema)) key: string,
    @Query(new ZodValidationPipe(guideInternalOneQuerySchema)) q: { tenantId: string },
  ): Promise<{ guide: ResolvedGuide | null }> {
    return (await runWithTenant({ id: q.tenantId }, () => this.reader.one(q.tenantId, key, languageOf(req)))).body;
  }
}

/** The language asked for: the middleware's when it ran, else the header's first tag. */
function languageOf(req: Request): string {
  const set = (req as Request & { language?: string }).language;
  if (set) return set;
  const header = req.headers['accept-language'];
  return (typeof header === 'string' && header.split(/[,;-]/)[0]?.trim().toLowerCase()) || 'fa';
}
