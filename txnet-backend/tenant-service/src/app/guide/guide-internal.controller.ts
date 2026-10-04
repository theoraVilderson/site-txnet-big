import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, runWithTenant } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import {
  guideInternalListQuerySchema,
  guideInternalOneQuerySchema,
  guideInternalSearchQuerySchema,
  guideInternalViewBodySchema,
  guideInternalViewQuerySchema,
  guideKeySchema,
} from './guide-public.schema';
import { GuidePlacementQuery, GuideReader, ResolvedGuide } from './guide-reader';
import type { GuideHit, GuideMatch } from './guide-search';
import { GuideFileSweep, SweepResult } from './guide-file-sweep';
import { GuideStats, viewerHash } from './guide-stats';

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
  constructor(
    private readonly reader: GuideReader,
    private readonly stats: GuideStats,
    private readonly files: GuideFileSweep,
  ) {}

  /**
   * The nightly sweep of unused guide files (F-414-m, ADR-0120 point 3), run
   * by worker-service's `guide_file_sweep`. Declared before `:key` so no key
   * can shadow it; a key is GET-only there anyway.
   */
  @Post('file-sweep')
  @HttpCode(200)
  sweep(): Promise<SweepResult> {
    return this.files.sweep();
  }

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

  /** A guide the bot sent (F-414-l): counted once a day per chat, as the panel's per viewer. */
  @Post(':key/view')
  @HttpCode(204)
  async view(
    @Req() req: Request,
    @Param('key', new ZodValidationPipe(guideKeySchema)) key: string,
    @Query(new ZodValidationPipe(guideInternalViewQuerySchema)) q: { tenantId: string },
    @Body(new ZodValidationPipe(guideInternalViewBodySchema)) body: { viewer: string },
  ): Promise<void> {
    await runWithTenant({ id: q.tenantId }, () => this.stats.view(q.tenantId, key, 'bot', viewerHash('bot', body.viewer), languageOf(req)));
  }
}

/** The bot's search (F-414-k): `GET /api/internal/guide-search` — its own path, so no key shadows it. */
@Controller('internal/guide-search')
@UseGuards(ServiceOnlyGuard)
export class GuideInternalSearchController {
  constructor(private readonly reader: GuideReader) {}

  @Get()
  async search(
    @Req() req: Request,
    @Query(new ZodValidationPipe(guideInternalSearchQuerySchema)) q: { tenantId: string; q: string; surface: 'panel' | 'bot'; match: GuideMatch },
  ): Promise<{ hits: GuideHit[] }> {
    return (await runWithTenant({ id: q.tenantId }, () => this.reader.search(q.tenantId, q.q, q.surface, languageOf(req), q.match))).body;
  }
}

/** The language asked for: the middleware's when it ran, else the header's first tag. */
function languageOf(req: Request): string {
  const set = (req as Request & { language?: string }).language;
  if (set) return set;
  const header = req.headers['accept-language'];
  return (typeof header === 'string' && header.split(/[,;-]/)[0]?.trim().toLowerCase()) || 'fa';
}
