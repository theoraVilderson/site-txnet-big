import { Injectable } from '@nestjs/common';

import { MigrationCommitService } from './migration-commit';
import { MigrationPreviewService } from './migration-preview';
import { MigrationRollbackService } from './migration-rollback';

/**
 * What one tick did: a run previewed or sent back to `draft`, the items a
 * commit batch reached, a commit ended; the items a rollback batch reached, a
 * rollback ended, the runs whose snapshots were purged (F-211).
 */
export type MigrationDrainResult = { previewed: number; returned: number; committed: number; finished: number; rolledBack: number; rollbacksFinished: number; purged: number };

/**
 * One tick of an import's background work (F-206, F-207, F-211), asked by
 * `worker-service` over the internal seam (ADR-0027): at most one dry run,
 * one commit batch, one rollback batch and a few purges, so a call stays
 * within its timeout — a snapshot alone may take two minutes.
 */
@Injectable()
export class MigrationDrainService {
  constructor(
    private readonly previews: MigrationPreviewService,
    private readonly commits: MigrationCommitService,
    private readonly rollbacks: MigrationRollbackService,
  ) {}

  async drain(now: Date = new Date()): Promise<MigrationDrainResult> {
    const preview = await this.previews.previewNext(now);
    const commit = await this.commits.commitNext(now);
    const rollback = await this.rollbacks.rollbackNext(now);
    const purged = await this.rollbacks.purgeEnded(now);
    return {
      previewed: preview === 'previewed' ? 1 : 0,
      returned: preview === 'returned' ? 1 : 0,
      committed: commit.items,
      finished: commit.outcome === 'finished' ? 1 : 0,
      rolledBack: rollback.items,
      rollbacksFinished: rollback.outcome === 'finished' ? 1 : 0,
      purged,
    };
  }
}
