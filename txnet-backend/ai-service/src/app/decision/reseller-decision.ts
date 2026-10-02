import { Injectable } from '@nestjs/common';
import { Prisma, type AiActionType } from '@prisma/client';
import { resolveTimeZone, runWithTenant, tenantTransaction, type QuietWindow } from '@txnet-backend/shared-core';

import type { AiTenantMode } from '../policy/ai-defaults';
import { AiReaderPrisma, PrismaService } from '../prisma/prisma.service';
import { HOURS_OF_WEEK } from '../profile/active-hours';
import type { Reason } from '../profile/predictions';
import { ResellerReader } from '../profile/reseller-reader';
import { SUGGEST_LEAD_DAYS } from './candidates';
import type { DecisionResult } from './decision-run';
import { DecisionPipeline } from './pipeline';
import { packageUpgradeCandidate, resellerTopUpCandidate } from './reseller-candidates';

const DAY_MS = 86_400_000;

/**
 * The reseller's upgrade (F-038-o4, ADR-0109 points 4, 8): in the platform's
 * hourly run, after its resellers' predictions (F-038-o1), every reseller
 * whose quota runs out inside the lead time goes through the same pipeline as
 * a user — subject `tenant`, so its opt-out, cooldown, holdout and budget are
 * the reseller's. It is told to the reseller's **owner** (user, 2026-10-02:
 * the quota alerts' recipient), a user of the platform's own tenant
 * (ADR-0062), so the owner's active hours and quiet window time it.
 */
@Injectable()
export class ResellerDecisionRun {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: AiReaderPrisma,
    private readonly resellers: ResellerReader,
    private readonly pipeline: DecisionPipeline,
  ) {}

  async runPlatform(platformTenantId: string, mode: AiTenantMode, now: Date): Promise<DecisionResult> {
    const result: DecisionResult = { subjects: 0, scheduled: 0, stopped: 0 };
    if (!mode.engineRuns) return result;
    const until = new Date(now.getTime() + SUGGEST_LEAD_DAYS * DAY_MS);
    const predictions = await runWithTenant({ id: platformTenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.aiPrediction.findMany({
          where: { tenantId: platformTenantId, subjectKind: 'tenant', kind: { in: ['quota_exhaustion', 'wallet_need'] }, predictedAt: { lte: until } },
          select: { id: true, subjectId: true, kind: true, value: true, currencyCode: true, predictedAt: true, confidence: true, reasons: true },
        }),
      ),
    );
    if (predictions.length === 0) return result;

    const rows = new Map((await this.resellers.resellers(platformTenantId)).map((r) => [r.tenantId, r]));
    const packages = await this.resellers.packages(platformTenantId);
    const subjects = [...new Set(predictions.map((p) => p.subjectId))].filter((id) => rows.has(id));
    const owners = [...new Set(subjects.map((id) => (rows.get(id) as { ownerUserId: string }).ownerUserId))];
    const ids = subjects;
    if (ids.length === 0) return result;

    const dayAgo = new Date(now.getTime() - DAY_MS);
    const own = await runWithTenant({ id: platformTenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const profiles = await tx.aiAccountProfile.findMany({ where: { tenantId: platformTenantId, subjectKind: 'user', subjectId: { in: owners } }, select: { subjectId: true, activeHours: true } });
        const actions = await tx.aiAction.findMany({
          where: { tenantId: platformTenantId, subjectKind: 'tenant', subjectId: { in: ids }, OR: [{ status: 'scheduled' }, { status: 'suppressed', createdAt: { gt: dayAgo } }] },
          select: { subjectId: true, status: true, actionType: true, suppressedBy: true, scheduledFor: true },
        });
        const tenant = await tx.tenant.findUnique({ where: { id: platformTenantId }, select: { timezone: true } });
        return { profiles, actions, zone: tenant?.timezone ?? null };
      }),
    );
    const theirs = await runWithTenant({ id: platformTenantId }, () =>
      tenantTransaction(this.reader, async (tx) => {
        const users = await tx.user.findMany({ where: { id: { in: owners } }, select: { id: true, timezone: true, timezoneSource: true } });
        const windows = await tx.$queryRaw<Array<{ userId: string; quietStart: number; quietEnd: number; timezone: string | null }>>`
          SELECT "userId", "quietStart", "quietEnd", "timezone" FROM ai.reader_quiet_hours
          WHERE "userId" = ANY(ARRAY[${Prisma.join(owners)}]::uuid[])`;
        return { users, windows };
      }),
    );

    for (const subjectId of subjects) {
      const row = rows.get(subjectId) as NonNullable<ReturnType<typeof rows.get>>;
      const quota = predictions.find((p) => p.subjectId === subjectId && p.kind === 'quota_exhaustion');
      const wallet = predictions.find((p) => p.subjectId === subjectId && p.kind === 'wallet_need');
      const upgrade = quota
        ? packageUpgradeCandidate(
            {
              prediction: { id: quota.id, predictedAt: quota.predictedAt, confidence: quota.confidence.toNumber(), reasons: quota.reasons as Reason[] },
              packageId: row.packageId,
              billingModel: row.billingModel,
              packages,
              ownLimitKeys: await this.resellers.ownLimitKeys(subjectId),
            },
            now,
          )
        : null;
      // F-1525-c: the billing wallet running out — help beside the upgrade, never instead of it.
      const topUp = wallet
        ? resellerTopUpCandidate({ id: wallet.id, predictedAt: wallet.predictedAt, confidence: wallet.confidence.toNumber(), value: wallet.value, currencyCode: wallet.currencyCode, reasons: wallet.reasons as Reason[] }, now)
        : null;
      const proposed = [upgrade, topUp].filter((c): c is NonNullable<typeof c> => c !== null);
      if (proposed.length === 0) continue;
      const owner = row.ownerUserId;
      const window = theirs.windows.find((w) => w.userId === owner);
      const user = theirs.users.find((u) => u.id === owner);
      const quiet: QuietWindow | null = window
        ? { quietStart: window.quietStart, quietEnd: window.quietEnd, timezone: window.timezone ?? resolveTimeZone({ user, tenant: { timezone: own.zone } }).zone }
        : null;
      const mine = own.actions.filter((a) => a.subjectId === subjectId);
      result.subjects += 1;
      const actions = await this.pipeline.decideAmong(
        { tenantId: platformTenantId, kind: 'tenant', id: subjectId },
        mode,
        proposed,
        {
          activeHours: own.profiles.find((x) => x.subjectId === owner)?.activeHours ?? new Array<number>(HOURS_OF_WEEK).fill(0),
          quiet,
          pendingSends: mine.filter((a) => a.status === 'scheduled' && a.scheduledFor).map((a) => a.scheduledFor as Date),
          stoppedToday: mine.filter((a) => a.status === 'suppressed').map((a) => ({ actionType: a.actionType as AiActionType, suppressedBy: a.suppressedBy })),
        },
        now,
      );
      for (const a of actions) {
        if (a.status === 'scheduled') result.scheduled += 1;
        else result.stopped += 1;
      }
    }
    return result;
  }
}
