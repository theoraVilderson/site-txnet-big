import { Injectable, Logger } from '@nestjs/common';
import { ObjectNotFound, ObjectStorage, guideBlocksSchema, guideFileKeys, parseObjectKey, runWithTenant } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/** A guide file younger than this is never swept: an editor may not have saved the text naming it yet (ADR-0120 point 3). */
export const GUIDE_FILE_GRACE_DAYS = 7;
/** Files deleted in one run at most; the next night takes the rest. */
export const GUIDE_FILE_SWEEP_MAX = 500;

export interface SweepResult {
  /** Guide files past the grace. */
  scanned: number;
  deleted: number;
  /** Bytes the deleted files held. */
  bytes: number;
  /** Past the grace but named by a text, or left for the next run. */
  kept: number;
}

/**
 * F-414-m — **unused guide files** (ADR-0120 point 3), run nightly by
 * worker-service's `guide_file_sweep` through `POST /api/internal/guides/file-sweep`.
 *
 * A file under any owner's `guides/`, older than the grace, that no published
 * text and no draft of **any** tenant names is deleted — row first, then
 * bytes, in the file's own tenant scope. Every tenant's texts are read
 * because a reseller's override names the platform's files (ADR-0117 point 2),
 * so no single owner can tell a file is unused. A text that does not parse
 * stops the run before anything is deleted: what it names is unknown.
 * Safe to run twice: a file already gone is skipped.
 */
@Injectable()
export class GuideFileSweep {
  private readonly logger = new Logger(GuideFileSweep.name);

  constructor(
    private readonly all: CrossTenantPrismaService,
    private readonly storage: ObjectStorage,
  ) {}

  async sweep(now = new Date()): Promise<SweepResult> {
    const cutoff = new Date(now.getTime() - GUIDE_FILE_GRACE_DAYS * 86_400_000);
    const candidates = (
      await this.all.storedObject.findMany({
        where: { key: { contains: '/guides/' }, createdAt: { lt: cutoff } },
        select: { key: true, tenantId: true, size: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      })
    ).filter((o) => parseObjectKey(o.key)?.path.startsWith('guides/'));
    if (candidates.length === 0) return { scanned: 0, deleted: 0, bytes: 0, kept: 0 };

    const named = await this.namedFiles();
    let deleted = 0;
    let bytes = 0;
    for (const o of candidates) {
      if (named.has(o.key) || deleted >= GUIDE_FILE_SWEEP_MAX) continue;
      try {
        await runWithTenant({ id: o.tenantId }, () => this.storage.delete(o.key));
      } catch (e) {
        if (!(e instanceof ObjectNotFound)) throw e;
        continue;
      }
      deleted += 1;
      bytes += o.size;
    }
    if (deleted > 0) this.logger.log(`swept ${deleted} unused guide file(s), ${bytes} bytes`);
    return { scanned: candidates.length, deleted, bytes, kept: candidates.length - deleted };
  }

  /** Every file any tenant's published text or draft names. */
  private async namedFiles(): Promise<Set<string>> {
    const [texts, drafts] = await Promise.all([
      this.all.guideTranslation.findMany({ select: { blocks: true } }),
      this.all.guideDraft.findMany({ select: { blocks: true } }),
    ]);
    const named = new Set<string>();
    for (const { blocks } of [...texts, ...drafts]) {
      const parsed = guideBlocksSchema.safeParse(blocks);
      if (!parsed.success) throw new Error('a guide text is unreadable; no guide file swept');
      for (const key of guideFileKeys(parsed.data)) named.add(key);
    }
    return named;
  }
}
