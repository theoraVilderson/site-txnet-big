import { Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { PublicRoute, TenantContext, publicPath, requestLanguage } from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { guideKeySchema, guideListQuerySchema, guideSearchQuerySchema } from './guide-public.schema';
import { GuidePlacementQuery, GuideRead, GuideReader, ResolvedGuide } from './guide-reader';
import type { GuideHit, GuideMatch } from './guide-search';
import { GuideStats, viewerHash } from './guide-stats';
import { LocaleService } from '../locale/locale.service';

/** `GET /api/public/tenant/guides` (F-414-b). */
export const GUIDES_PATH = publicPath('tenant', 'guides');

/** `GET /api/public/tenant/guide-search` (F-414-j) — its own path, so no guide key can shadow it. */
export const GUIDE_SEARCH_PATH = publicPath('tenant', 'guide-search');

/**
 * Revalidate every time: the ETag makes that a 304 with no query, and a guide
 * edited a minute ago is not shown stale. Varies by language, since the body does.
 */
const CACHE_HEADERS = { 'Cache-Control': 'public, no-cache', Vary: 'Accept-Language' };

/**
 * A tenant's guides, to anyone on its panel Host (F-414-b, ADR-0115): public,
 * because a stranger's first screen may need its help. The tenant is the
 * Host's (`PublicHostMiddleware`), so a reseller's domain answers with its own
 * guides and the platform's it has not replaced or hidden — never another
 * reseller's. The language is `Accept-Language`'s, and the guide says which it
 * served. The bot reads the same resolver by tenant (`GuideInternalController`, F-414-f).
 */
@Controller(GUIDES_PATH)
export class GuidePublicController {
  constructor(
    private readonly reader: GuideReader,
    private readonly stats: GuideStats,
    private readonly locale: LocaleService,
  ) {}

  @Get()
  @PublicRoute({ doors: ['panel'] })
  async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query(new ZodValidationPipe(guideListQuerySchema)) q: GuidePlacementQuery,
  ): Promise<{ guides: ResolvedGuide[] } | undefined> {
    const tenantId = TenantContext.current('guides by host').id;
    const lang = requestLanguage(req, this.locale);
    const etag = await this.reader.etag(tenantId, ['list', q.targetKind, q.targetRef, q.surface, lang]);
    if (notModified(req, res, etag)) return undefined;
    return answer(res, await this.reader.list(tenantId, q, lang));
  }

  /** One guide by key; a 404 when the tenant sees none (unknown, hidden, archived, unpublished). */
  @Get(':key')
  @PublicRoute({ doors: ['panel'] })
  async one(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('key', new ZodValidationPipe(guideKeySchema)) key: string,
  ): Promise<{ guide: ResolvedGuide } | undefined> {
    const tenantId = TenantContext.current('guide by host').id;
    const lang = requestLanguage(req, this.locale);
    const etag = await this.reader.etag(tenantId, ['one', key, lang]);
    if (notModified(req, res, etag)) return undefined;
    const read = await this.reader.one(tenantId, key, lang);
    if (!read.body.guide) throw new NotFoundException();
    return answer(res, read) as { guide: ResolvedGuide };
  }

  /**
   * A guide shown whole on the panel (F-414-l, ADR-0119): counted once a day
   * per viewer — a hash of IP and user agent, never the IP. Always a 204, so
   * the answer never says whether a view counted or a key exists.
   */
  @Post(':key/view')
  @HttpCode(204)
  @PublicRoute({ doors: ['panel'] })
  async view(@Req() req: Request, @Param('key', new ZodValidationPipe(guideKeySchema)) key: string): Promise<void> {
    const tenantId = TenantContext.current('guide view by host').id;
    const viewer = viewerHash(req.ip ?? '', String(req.headers['user-agent'] ?? ''));
    await this.stats.view(tenantId, key, 'panel', viewer, requestLanguage(req, this.locale));
  }
}

/**
 * Searching a tenant's guides (F-414-j), to anyone on its panel Host, as the
 * read above: the same resolved set, so a search finds only what that tenant
 * may read. The public prefix's per-IP limit bounds it.
 */
@Controller(GUIDE_SEARCH_PATH)
export class GuideSearchController {
  constructor(
    private readonly reader: GuideReader,
    private readonly locale: LocaleService,
  ) {}

  @Get()
  @PublicRoute({ doors: ['panel'] })
  async search(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query(new ZodValidationPipe(guideSearchQuerySchema)) q: { q: string; surface: 'panel' | 'bot'; match: GuideMatch },
  ): Promise<{ hits: GuideHit[] } | undefined> {
    const tenantId = TenantContext.current('guide search by host').id;
    const read = await this.reader.search(tenantId, q.q, q.surface, requestLanguage(req, this.locale), q.match);
    if (notModified(req, res, read.etag)) return undefined;
    return answer(res, read);
  }
}


/** A 304 when the caller holds the current ETag; Express drops the body. */
function notModified(req: Request, res: Response, etag: string | null): boolean {
  if (!etag || req.headers['if-none-match'] !== etag) return false;
  res.set({ ...CACHE_HEADERS, ETag: etag }).status(304);
  return true;
}

function answer<T>(res: Response, read: GuideRead<T>): T {
  res.set(read.etag ? { ...CACHE_HEADERS, ETag: read.etag } : { 'Cache-Control': 'no-store', Vary: 'Accept-Language' });
  return read.body;
}
