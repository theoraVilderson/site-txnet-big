import { Injectable } from '@nestjs/common';
import { ResellerAccess, ResellerAccessRefused, ResellerActor, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { dayOf } from './analytics-days';
import { lockTenantRollup } from './analytics-rollup';
import { restateGrantEnds } from './analytics-rollup-customers';
import { announce } from './analytics-rollup.service';
import { AnalyticsSettings, AnalyticsSettingsBody, settingsOf } from './analytics-settings';
import { AnalyticsRefused } from './analytics.service';

/**
 * A tenant's analytics settings: the renewal window (F-1001-f) and the loss
 * alert's threshold (F-1003). The door is the
 * settings key — the owner, a member holding `settings.manage`, or the
 * platform's staff with `platform.tenant.manage` — not `analytics.read`: the
 * number changes what every reader of the tenant is shown.
 *
 * A changed window re-states every ended term under it in the same
 * transaction, under the rollup's lock, and bumps the rollup version, so no
 * cached answer from the old window is served after it and every open page
 * re-reads (`billing.analytics.refreshed`, C-14); so does a changed percent,
 * which the margin tab answers.
 */
@Injectable()
export class AnalyticsSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  async setSettings(actor: ResellerActor, tenantId: string, body: AnalyticsSettingsBody, now = new Date()): Promise<AnalyticsSettings> {
    try {
      return await this.access
        .for('settings.manage')
        .asStaff('platform.tenant.manage')
        .runFiguresIncludingPlatform(actor, tenantId, 'staffWrite', () =>
          tenantTransaction(this.prisma, async (tx) => {
            await lockTenantRollup(tx);
            // A first write of one setting stores the other's default beside it.
            const before = await settingsOf(tx);
            const next = { ...before, ...body };
            const row = { ...next, updatedByUserId: actor.userId };
            await tx.analyticsSetting.upsert({ where: { tenantId }, create: { tenantId, ...row }, update: row });
            const { timezone } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
            const today = dayOf(now, timezone);
            const restated = body.renewalWindowDays !== undefined && (await restateGrantEnds(tx, { window: body.renewalWindowDays, today })) > 0;
            // The margin tab answers the percent, so a new one retires its cached answers too.
            if (restated || next.lossAlertPercent !== before.lossAlertPercent) {
              await tx.analyticsRollupState.updateMany({ where: { tenantId }, data: { version: { increment: 1 } } });
              await announce(tx, tenantId, today, today);
            }
            return next;
          }),
        );
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new AnalyticsRefused(e.reason, tenantId);
      throw e;
    }
  }
}
