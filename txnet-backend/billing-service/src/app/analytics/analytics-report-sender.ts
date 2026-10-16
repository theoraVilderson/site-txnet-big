import { Injectable } from '@nestjs/common';
import type { AnalyticsReportSchedule } from '@prisma/client';
import { OutboxEventType, operatingCurrencyOf, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { panelUrlOf } from '../request/panel-url';
import type { Day } from './analytics-days';
import { ReportTiming, nextRunAt, periodOf } from './analytics-report-clock';
import { reportKpisSchema, reportParams } from './analytics-report-figures';
import { ReportTab, isReportTab } from './analytics-reports.schema';
import { analyticsStaffOf } from './analytics-staff';
import { AnalyticsService } from './analytics.service';

/** The panel's analytics page — `PANEL_ANALYTICS` in `site-pwa/src/lib/routes.ts` (C-10). */
const PANEL_ANALYTICS_PATH = '/analytics';
/** A reseller's owner reads its figures on the platform's panel, in the workspace (panel-web workspace rule 4). */
const PANEL_RESELLER_ANALYTICS_PATH = '/reseller/analytics';

/** What one send did: told, left for a person who no longer reads the figures, taken by another run, or put off while the rollup rebuilds. */
export type ReportOutcome = 'sent' | 'skipped' | 'taken' | 'rebuilding';

/** The channels a report goes on, as the worker tells them. */
export function channelsOf(s: Pick<AnalyticsReportSchedule, 'bot' | 'email'>): ('bot' | 'email')[] {
  const channels: ('bot' | 'email')[] = [];
  if (s.bot) channels.push('bot');
  if (s.email) channels.push('email');
  return channels;
}

export const timingOf = (s: Pick<AnalyticsReportSchedule, 'frequency' | 'weekday' | 'hour' | 'calendar'>): ReportTiming => ({
  frequency: s.frequency,
  weekday: s.weekday,
  hour: s.hour,
  calendar: s.calendar,
});

/**
 * One scheduled report (F-1006-a, contract.analytics-reports.md "Sending"):
 * its person judged again (still one of the tenant's analytics staff,
 * ADR-0150 (3)), the Overview's figures for the period that closed before
 * now, and one `billing.analytics.report` event — the words are auth-service's,
 * the channels the worker's. With `claim` (the worker's run) the run is taken
 * only while `nextRunAt` still holds it, moved on in the event's transaction,
 * so two runs never send it twice.
 */
@Injectable()
export class AnalyticsReportSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    /** The person's home tenant and its panel host: a reseller's owner lives on the platform's. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  send(s: AnalyticsReportSchedule, now: Date, claim: Date | null): Promise<ReportOutcome> {
    return runWithTenant({ id: s.tenantId }, async () => {
      const tenant = await tenantTransaction(this.prisma, async (tx) => {
        const row = await tx.tenant.findUniqueOrThrow({ where: { id: s.tenantId }, select: { timezone: true, ownerUserId: true } });
        return { zone: row.timezone, staff: await analyticsStaffOf(tx, { id: s.tenantId, ownerUserId: row.ownerUserId }), operating: await operatingCurrencyOf(tx, s.tenantId) };
      });
      const timing = timingOf(s);
      const next = nextRunAt(timing, tenant.zone, now);
      if (!tenant.staff.includes(s.userId)) {
        // Moved on all the same: a due row left behind would be read again every tick, ahead of the rest.
        if (claim) await this.move(s.id, claim, next);
        return 'skipped';
      }

      const period = periodOf(timing, tenant.zone, now);
      const answer = await this.analytics.readTrusted(s.tenantId, 'overview', { ...period, compare: 'previous', calendar: s.calendar });
      // Left due: a rebuild ends within minutes, and the next tick sends it whole.
      if (answer.rebuilding) return 'rebuilding';
      const tab: ReportTab = isReportTab(s.tab) ? s.tab : 'overview';
      const link = await this.linkOf(s, tab, period);
      const payload = { tenantId: s.tenantId, userId: s.userId, scheduleId: s.id, channels: channelsOf(s), tab, ...(link ? { link } : {}), ...reportParams(reportKpisSchema.parse(answer), tenant.operating, period) };

      const told = await tenantTransaction(this.prisma, async (tx) => {
        if (claim) {
          const { count } = await tx.analyticsReportSchedule.updateMany({ where: { id: s.id, nextRunAt: claim, pausedAt: null }, data: { nextRunAt: next, lastSentAt: now } });
          if (count === 0) return false;
        } else {
          await tx.analyticsReportSchedule.update({ where: { id: s.id }, data: { lastSentAt: now } });
        }
        await tx.outboxEvent.create({ data: { aggregate: 'billing.analytics', aggregateId: s.id, type: OutboxEventType.ANALYTICS_REPORT, payload } });
        return true;
      });
      return told ? 'sent' : 'taken';
    });
  }

  /** The run moved on without a report, while it is still this run's to move. */
  private async move(id: string, claim: Date, next: Date): Promise<void> {
    await tenantTransaction(this.prisma, (tx) => tx.analyticsReportSchedule.updateMany({ where: { id, nextRunAt: claim }, data: { nextRunAt: next } }));
  }

  /** The period on the person's own panel — their tenant's `/analytics`, or the workspace for a reseller's owner; none without a host. */
  private async linkOf(s: AnalyticsReportSchedule, tab: ReportTab, period: { from: Day; to: Day }): Promise<string | null> {
    const home = (await this.all.user.findUnique({ where: { id: s.userId }, select: { tenantId: true } }))?.tenantId ?? s.tenantId;
    const path = home === s.tenantId ? PANEL_ANALYTICS_PATH : PANEL_RESELLER_ANALYTICS_PATH;
    const search = new URLSearchParams({ tab, range: 'custom', from: period.from, to: period.to });
    return panelUrlOf(this.all, home, `${path}?${search.toString()}`);
  }
}
