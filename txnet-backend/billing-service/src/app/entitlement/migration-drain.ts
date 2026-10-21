import { Injectable } from '@nestjs/common';

import { MigrationPreviewService } from './migration-preview';

/** What one tick did: a run previewed, or one sent back to `draft` with its reason. */
export type MigrationDrainResult = { previewed: number; returned: number };

/**
 * One tick of an import's background work (F-206), asked by `worker-service`
 * over the internal seam (ADR-0027): at most one dry run, so a call stays
 * within its timeout — a snapshot alone may take two minutes.
 */
@Injectable()
export class MigrationDrainService {
  constructor(private readonly previews: MigrationPreviewService) {}

  async drain(now: Date = new Date()): Promise<MigrationDrainResult> {
    const preview = await this.previews.previewNext(now);
    return { previewed: preview === 'previewed' ? 1 : 0, returned: preview === 'returned' ? 1 : 0 };
  }
}
