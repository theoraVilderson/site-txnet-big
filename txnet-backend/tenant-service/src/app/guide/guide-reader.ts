import { Injectable, Logger } from '@nestjs/common';
import type { GuideKind, GuideSurface, GuideTargetKind } from '@prisma/client';
import { FALLBACK_LANGS } from '@txnet/locale-client';
import { type GuideBlock, UnscopedRedisKeys, tenantTransaction } from '@txnet-backend/shared-core';
import { createHash, randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GuideHit, GuideMatch, normalizeForSearch, searchGuides } from './guide-search';

/**
 * F-414-b — **what one tenant's users see** (ADR-0115 point 3, ADR-0117).
 *
 * Nearest owner wins, by key: the tenant's own **live** guide (active, with a
 * published text) replaces the platform's of the same key wherever either is
 * placed; a hide drops the platform's; an own draft or an archived copy
 * replaces nothing, so a reseller's users keep the platform's guide until the
 * reseller publishes its own. Only `guide_translation` is read — the published
 * text; a draft (`guide_draft`, F-414-c) is never served here.
 *
 * Cached by generation: each owner has a random token every write replaces
 * ({@link GuideGenerations}); a read's ETag hashes the request with the
 * platform's and the tenant's tokens, so it is known before any query — a
 * matching `If-None-Match` is a 304 with none — and the body is cached under
 * it. Redis down costs the cache, never the answer.
 */

/**
 * The cached body's shape. Part of every ETag, so a body cached before a field
 * was added (`id`, F-414-l) is never served after it.
 */
const READ_SHAPE = 'r2';

/** How long a resolved read is kept. A write changes the ETag at once; this only bounds memory. */
export const GUIDE_CACHE_TTL_SEC = 600;

export type GuideOwner = 'platform' | 'own';

/** A guide row as the reader loads it — what `guide.findMany` returns with its texts and placements. */
export interface GuideStoreRow {
  id: string;
  tenantId: string | null;
  key: string;
  kind: GuideKind;
  sortOrder: number;
  isActive: boolean;
  updatedAt: Date;
  translations: { lang: string; title: string; blocks: unknown }[];
  placements: { surface: GuideSurface; targetKind: GuideTargetKind; targetRef: string }[];
}

/** One guide as a renderer receives it. Files are object keys; the caller builds the URL (ADR-0116 point 3). */
export interface ResolvedGuide {
  /** The row shown — the platform's or the tenant's own; what a view or a vote is counted against (F-414-l). */
  id: string;
  key: string;
  kind: GuideKind;
  owner: GuideOwner;
  /** The language served — the asked one, else the first of the fallback order the guide has. */
  lang: string;
  title: string;
  blocks: GuideBlock[];
  sortOrder: number;
  updatedAt: string;
}

/** A placement as a reader asks for it; a placement on `any` shows on both surfaces. */
export interface GuidePlacementQuery {
  targetKind: GuideTargetKind;
  targetRef: string;
  surface: Exclude<GuideSurface, 'any'>;
}

export interface GuideRead<T> {
  /** `null` when Redis could not be read: nothing can promise the next answer equals this one. */
  etag: string | null;
  body: T;
}

/** A guide that is shown: active and published in at least one language. */
const LIVE = { isActive: true, translations: { some: {} } } as const;

const SELECT = {
  id: true,
  tenantId: true,
  key: true,
  kind: true,
  sortOrder: true,
  isActive: true,
  updatedAt: true,
  translations: { select: { lang: true, title: true, blocks: true } },
  placements: { select: { surface: true, targetKind: true, targetRef: true } },
} as const;

/**
 * One random token per owner, replaced by every write of that owner's guides
 * (`RedisKeys.guideGeneration`). A token, not a counter: a counter lost to an
 * eviction restarts at a number an old cached body may still be filed under.
 */
@Injectable()
export class GuideGenerations {
  constructor(private readonly redis: RedisService) {}

  /** The current token, minted on first use. Throws when Redis does. */
  async of(tenantId: string | null): Promise<string> {
    const key = UnscopedRedisKeys.guideGeneration(tenantId ?? 'platform');
    const token = await this.redis.get(key);
    if (token) return token;
    await this.redis.setIfAbsent(key, randomUUID());
    return (await this.redis.get(key)) ?? '';
  }

  /** After a write to `tenantId`'s guides (`null` = the platform's): every cached read of them is stale. */
  async bump(tenantId: string | null): Promise<void> {
    await this.redis.set(UnscopedRedisKeys.guideGeneration(tenantId ?? 'platform'), randomUUID());
  }
}

@Injectable()
export class GuideReader {
  private readonly logger = new Logger(GuideReader.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly generations: GuideGenerations,
  ) {}

  /** The guides placed in one slot, for the tenant in scope. */
  list(tenantId: string, q: GuidePlacementQuery, lang: string): Promise<GuideRead<{ guides: ResolvedGuide[] }>> {
    return this.cached(tenantId, ['list', q.targetKind, q.targetRef, q.surface, lang], async () => ({
      guides: await this.resolve(tenantId, lang, {
        placements: { some: { targetKind: q.targetKind, targetRef: q.targetRef, surface: { in: [q.surface, 'any'] } } },
      }),
    }));
  }

  /** One guide by key, wherever it is placed; `guide: null` when the tenant sees none. */
  one(tenantId: string, key: string, lang: string): Promise<GuideRead<{ guide: ResolvedGuide | null }>> {
    return this.cached(tenantId, ['one', key, lang], async () => ({
      guide: (await this.resolve(tenantId, lang, { key }))[0] ?? null,
    }));
  }

  /**
   * The guides matching `q` among every guide this tenant sees on `surface`
   * (F-414-j). The whole resolved set is cached by generation like any read;
   * the match runs on it per request, so a query string never becomes a key.
   */
  async search(tenantId: string, q: string, surface: Exclude<GuideSurface, 'any'>, lang: string, match: GuideMatch = 'all'): Promise<GuideRead<{ hits: GuideHit[] }>> {
    const all = await this.cached(tenantId, ['all', surface, lang], async () => ({
      guides: await this.resolve(tenantId, lang, { placements: { some: { surface: { in: [surface, 'any'] } } } }),
    }));
    const etag = all.etag ? await this.etag(tenantId, ['search', surface, lang, match, normalizeForSearch(q)]) : null;
    return { etag, body: { hits: searchGuides(all.body.guides, q, match) } };
  }

  /** The ETag a read of `parts` would carry now, from the generations alone; `null` without Redis. */
  async etag(tenantId: string, parts: string[]): Promise<string | null> {
    try {
      const [platform, own] = await Promise.all([this.generations.of(null), this.generations.of(tenantId)]);
      const hash = createHash('sha256').update([READ_SHAPE, tenantId, platform, own, ...parts].join('\n')).digest('base64url');
      return `"g-${hash.slice(0, 32)}"`;
    } catch (err) {
      this.logger.warn(`guide generations unreadable, serving uncached: ${(err as Error).message}`);
      return null;
    }
  }

  private async cached<T>(tenantId: string, parts: string[], load: () => Promise<T>): Promise<GuideRead<T>> {
    const etag = await this.etag(tenantId, parts);
    if (etag) {
      const hit = await this.redis.get(UnscopedRedisKeys.guideResolved(tenantId, etag)).catch(() => null);
      if (hit) return { etag, body: JSON.parse(hit) as T };
    }
    const body = await load();
    if (etag) {
      await this.redis
        .setWithTtl(UnscopedRedisKeys.guideResolved(tenantId, etag), JSON.stringify(body), GUIDE_CACHE_TTL_SEC)
        .catch((err: Error) => this.logger.warn(`guide cache write failed: ${err.message}`));
    }
    return { etag, body };
  }

  private async resolve(tenantId: string, lang: string, where: Record<string, unknown>): Promise<ResolvedGuide[]> {
    const { candidates, ownLive, hidden } = await tenantTransaction(this.prisma, async (tx) => {
      // RLS shows this tenant the platform's rows and its own (invariant 1).
      const candidates = (await tx.guide.findMany({ where: { ...where, ...LIVE }, select: SELECT })) as GuideStoreRow[];
      const platformKeys = candidates.filter((c) => c.tenantId === null).map((c) => c.key);
      if (platformKeys.length === 0) return { candidates, ownLive: [], hidden: [] };
      const [ownLive, hidden] = await Promise.all([
        tx.guide.findMany({ where: { tenantId, key: { in: platformKeys }, ...LIVE }, select: { key: true } }),
        tx.guideHidden.findMany({ where: { tenantId, key: { in: platformKeys } }, select: { key: true } }),
      ]);
      return { candidates, ownLive, hidden };
    });
    return resolveGuides(candidates, new Set([...ownLive, ...hidden].map((r) => r.key)), lang);
  }
}

/**
 * Nearest owner wins (invariant 3): a platform guide whose key the tenant has
 * replaced (a live own guide) or hidden is dropped; then each guide in the
 * asked language, else the fallback order, else any (invariant 4).
 */
export function resolveGuides(candidates: GuideStoreRow[], shadowed: Set<string>, lang: string): ResolvedGuide[] {
  return candidates
    .filter((c) => c.tenantId !== null || !shadowed.has(c.key))
    .flatMap((c) => {
      const text = pickTranslation(c.translations, lang);
      if (!text) return [];
      return [
        {
          id: c.id,
          key: c.key,
          kind: c.kind,
          owner: (c.tenantId === null ? 'platform' : 'own') as GuideOwner,
          lang: text.lang,
          title: text.title,
          blocks: text.blocks as GuideBlock[],
          sortOrder: c.sortOrder,
          updatedAt: c.updatedAt.toISOString(),
        },
      ];
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

/** The text in `lang`, else along the locale client's `FALLBACK_LANGS` (i18n contract), else any. */
export function pickTranslation<T extends { lang: string }>(texts: T[], lang: string): T | undefined {
  for (const l of [lang, ...FALLBACK_LANGS]) {
    const hit = texts.find((t) => t.lang === l);
    if (hit) return hit;
  }
  return texts[0];
}
