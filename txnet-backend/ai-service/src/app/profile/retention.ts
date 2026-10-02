import { Injectable } from '@nestjs/common';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { PROFILE_HISTORY_DAYS } from './profile-features';
import { ProfileReader, type AccountState } from './profile-reader';

const DAY_MS = 86_400_000;
/** Subjects checked against identity per reader transaction. */
const ERASE_PAGE = 500;

/**
 * The subjects of `ids` to erase: an account identity shows as deleted, and
 * one it no longer shows at all — but the second only when the reader sees
 * any account of the tenant. A reader that sees none (FORCE RLS on its
 * owner, a lost tenant binding) proves nothing about who is gone, and
 * reading it as "everyone" would erase the tenant (ADR-0109 point 14).
 */
export function erasable(ids: string[], seen: AccountState[], readerSeesTenant: boolean): string[] {
  const state = new Map(seen.map((s) => [s.id, s.deletedAt]));
  return ids.filter((id) => (state.has(id) ? state.get(id) !== null : readerSeesTenant));
}

/**
 * Retention (F-038-s, ADR-0109 point 14), one tenant in its scope, run by
 * the hourly rebuild for **every** tenant, its engine on or off — a tenant
 * whose engine stopped still holds rows that must not outlive their window:
 *
 * 1. readings (`ai.meter_reading`, the raw behaviour events) older than 180
 *    days are deleted;
 * 2. every user subject `ai` holds a row about — reading, profile,
 *    prediction, action, holdout, opt-out, attention budget — is checked
 *    against identity, and one deleted or gone has all of them deleted.
 *
 * A reseller (subject `tenant`) is not an account and is not touched here.
 * Safe to run twice: a second run finds nothing left to delete.
 */
@Injectable()
export class Retention {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: ProfileReader,
  ) {}

  runTenant(tenantId: string, now: Date): Promise<{ purged: number; erased: number }> {
    return runWithTenant({ id: tenantId }, async () => {
      const since = new Date(now.getTime() - PROFILE_HISTORY_DAYS * DAY_MS);
      const purged = await tenantTransaction(this.prisma, (tx) =>
        tx.aiMeterReading.deleteMany({ where: { tenantId, hour: { lt: since } } }),
      );

      const subjects = await tenantTransaction(this.prisma, (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          SELECT "userId" AS id FROM ai.meter_reading WHERE "tenantId" = ${tenantId}::uuid
          UNION SELECT "subjectId" FROM ai.account_profile WHERE "tenantId" = ${tenantId}::uuid AND "subjectKind" = 'user'
          UNION SELECT "subjectId" FROM ai.prediction WHERE "tenantId" = ${tenantId}::uuid AND "subjectKind" = 'user'
          UNION SELECT "subjectId" FROM ai.action WHERE "tenantId" = ${tenantId}::uuid AND "subjectKind" = 'user'
          UNION SELECT "subjectId" FROM ai.holdout WHERE "tenantId" = ${tenantId}::uuid AND "subjectKind" = 'user'
          UNION SELECT "subjectId" FROM ai.opt_out WHERE "tenantId" = ${tenantId}::uuid AND "subjectKind" = 'user'
          UNION SELECT "subjectId" FROM engagement.attention_budget WHERE "tenantId" = ${tenantId}::uuid AND "subjectKind" = 'user'
          ORDER BY id`,
      );
      if (subjects.length === 0) return { purged: purged.count, erased: 0 };

      const seesTenant = await this.reader.seesAnyAccount();
      let erased = 0;
      for (let i = 0; i < subjects.length; i += ERASE_PAGE) {
        const ids = subjects.slice(i, i + ERASE_PAGE).map((s) => s.id);
        const gone = erasable(ids, await this.reader.accountStates(ids), seesTenant);
        if (gone.length === 0) continue;
        const bySubject = { where: { tenantId, subjectKind: 'user' as const, subjectId: { in: gone } } };
        await tenantTransaction(this.prisma, async (tx) => {
          await tx.aiMeterReading.deleteMany({ where: { tenantId, userId: { in: gone } } });
          await tx.aiAccountProfile.deleteMany(bySubject);
          await tx.aiPrediction.deleteMany(bySubject);
          await tx.aiAction.deleteMany(bySubject);
          await tx.aiHoldout.deleteMany(bySubject);
          await tx.aiOptOut.deleteMany(bySubject);
          await tx.attentionBudget.deleteMany(bySubject);
        });
        erased += gone.length;
      }
      return { purged: purged.count, erased };
    });
  }
}
