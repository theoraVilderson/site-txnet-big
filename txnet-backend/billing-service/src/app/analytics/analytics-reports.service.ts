import { Injectable, Logger } from '@nestjs/common';
import type { AnalyticsReportSchedule, Prisma } from '@prisma/client';
import { AdmittedReseller, ResellerAccess, ResellerAccessRefused, ResellerActor, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { nextRunAt } from './analytics-report-clock';
import { AnalyticsReportSender, ReportOutcome, timingOf } from './analytics-report-sender';
import { ReportScheduleBody, ReportScheduleChange } from './analytics-reports.schema';
import { ANALYTICS_READ, analyticsStaffOf } from './analytics-staff';

/** A person's schedules in one tenant, at most: a report is read by a person, and ten a day is already a lot (C-28). */
export const REPORT_SCHEDULES_PER_PERSON = 10;
/** Due schedules one worker run sends, oldest first — the rest are the next run's (C-28). */
export const REPORTS_PER_RUN = 200;

export type ReportRefusal = 'not_allowed' | 'reseller_not_found' | 'reseller_suspended' | 'reseller_terminated' | 'not_found' | 'too_many_schedules' | 'rebuilding';

export class ReportRefused extends Error {
  constructor(readonly reason: ReportRefusal) {
    super(reason);
    this.name = 'ReportRefused';
  }
}

/** A schedule as answered: who it goes to (named for the owner's view), when, where, and its next and last send. */
export type ReportScheduleView = Omit<AnalyticsReportSchedule, 'tenantId' | 'pausedAt' | 'createdAt' | 'updatedAt'> & { paused: boolean; mine: boolean; name: string | null };

/** What one worker run did. */
export type ReportRunResult = { due: number; sent: number; skipped: number; failed: number };

const viewOf = (s: AnalyticsReportSchedule, me: string, name: string | null): ReportScheduleView => ({
  id: s.id,
  userId: s.userId,
  frequency: s.frequency,
  weekday: s.weekday,
  hour: s.hour,
  calendar: s.calendar,
  tab: s.tab,
  bot: s.bot,
  email: s.email,
  paused: s.pausedAt !== null,
  nextRunAt: s.nextRunAt,
  lastSentAt: s.lastSentAt,
  mine: s.userId === me,
  name,
});

/**
 * A person's scheduled reports (F-1006-a, contract.analytics-reports.md,
 * ADR-0150 (3)): made by one of the tenant's analytics staff for themselves,
 * through the analytics door; seen and changed by that person — and by the
 * tenant's owner, who may pause or remove any. The worker's run sends each
 * due one through `AnalyticsReportSender`.
 */
@Injectable()
export class AnalyticsReportService {
  private readonly logger = new Logger(AnalyticsReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly sender: AnalyticsReportSender,
    /** The due schedules of every tenant — the one cross-tenant read; each send runs in its tenant's scope. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /** The schedules the caller may see — their own, or every one for the owner — and where the caller can be reached. */
  list(actor: ResellerActor, tenantId: string) {
    return this.door(actor, tenantId, async (admitted, tx) => {
      const rows = await tx.analyticsReportSchedule.findMany({ where: admitted.as === 'owner' ? {} : { userId: actor.userId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const people = await this.all.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, fullName: true, username: true } });
      const names = new Map(people.map((p) => [p.id, p.fullName ?? p.username ?? null]));
      return { schedules: rows.map((r) => viewOf(r, actor.userId, names.get(r.userId) ?? null)), reach: await this.reachOf(actor.userId) };
    });
  }

  /** A new schedule for the caller, who must be one of the tenant's analytics staff. */
  create(actor: ResellerActor, tenantId: string, body: ReportScheduleBody, now = new Date()) {
    return this.door(actor, tenantId, async (_admitted, tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, ownerUserId: true } });
      if (!(await analyticsStaffOf(tx, { id: tenantId, ownerUserId: tenant.ownerUserId })).includes(actor.userId)) throw new ReportRefused('not_allowed');
      if ((await tx.analyticsReportSchedule.count({ where: { userId: actor.userId } })) >= REPORT_SCHEDULES_PER_PERSON) throw new ReportRefused('too_many_schedules');
      const timing = { frequency: body.frequency, weekday: body.frequency === 'weekly' ? (body.weekday ?? null) : null, hour: body.hour, calendar: body.calendar };
      const row = await tx.analyticsReportSchedule.create({
        data: { tenantId, userId: actor.userId, ...timing, tab: body.tab, bot: body.bot, email: body.email, nextRunAt: nextRunAt(timing, tenant.timezone, now) },
      });
      return viewOf(row, actor.userId, null);
    });
  }

  /** A change to one schedule; a new timing or a resume measures the next run from now. */
  change(actor: ResellerActor, tenantId: string, id: string, body: ReportScheduleChange, now = new Date()) {
    return this.door(actor, tenantId, async (admitted, tx) => {
      const row = await this.ownOrOwned(tx, admitted, actor, id);
      // The owner may pause or resume anyone's; only its person may change what it says.
      if (row.userId !== actor.userId && Object.keys(body).some((k) => k !== 'paused')) throw new ReportRefused('not_allowed');
      const { paused, ...fields } = body;
      const merged = { ...row, ...fields, weekday: (fields.frequency ?? row.frequency) === 'weekly' ? (fields.weekday ?? row.weekday) : null };
      const zone = (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } })).timezone;
      const data: Prisma.AnalyticsReportScheduleUpdateInput = { ...fields, weekday: merged.weekday, nextRunAt: nextRunAt(timingOf(merged), zone, now) };
      if (paused !== undefined) data.pausedAt = paused ? (row.pausedAt ?? now) : null;
      const updated = await tx.analyticsReportSchedule.update({ where: { id }, data });
      return viewOf(updated, actor.userId, null);
    });
  }

  remove(actor: ResellerActor, tenantId: string, id: string) {
    return this.door(actor, tenantId, async (admitted, tx) => {
      await this.ownOrOwned(tx, admitted, actor, id);
      await tx.analyticsReportSchedule.delete({ where: { id } });
      return { removed: true };
    });
  }

  /** "Send now" (F-1006-b): the period that closed before now, to the caller's own schedule; its next run stays. */
  async sendNow(actor: ResellerActor, tenantId: string, id: string, now = new Date()) {
    const row = await this.door(actor, tenantId, async (admitted, tx) => {
      const own = await this.ownOrOwned(tx, admitted, actor, id);
      if (own.userId !== actor.userId) throw new ReportRefused('not_allowed');
      return own;
    });
    const outcome = await this.sender.send(row, now, null);
    if (outcome === 'skipped') throw new ReportRefused('not_allowed');
    if (outcome === 'rebuilding') throw new ReportRefused('rebuilding');
    return { sent: true };
  }

  /** The worker's run: every due schedule, oldest first, each alone — one failing is counted, never stops the rest. */
  async run(now = new Date()): Promise<ReportRunResult> {
    const due = await this.all.analyticsReportSchedule.findMany({ where: { pausedAt: null, nextRunAt: { lte: now } }, orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }], take: REPORTS_PER_RUN });
    const result: ReportRunResult = { due: due.length, sent: 0, skipped: 0, failed: 0 };
    for (const s of due) {
      try {
        const outcome: ReportOutcome = await this.sender.send(s, now, s.nextRunAt);
        if (outcome === 'sent') result.sent++;
        else if (outcome === 'skipped') result.skipped++;
      } catch (e) {
        result.failed++;
        this.logger.error(`report ${s.id} of tenant ${s.tenantId} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (result.sent > 0) this.logger.log(`reports: ${result.sent} sent of ${result.due} due, ${result.skipped} to people who no longer read the figures`);
    return result;
  }

  /** Where the caller can be reached: a verified bot chat, a verified email — read where the person lives. */
  private async reachOf(userId: string): Promise<{ bot: boolean; email: boolean }> {
    const user = await this.all.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    const bots = await this.all.linkedBotAccount.count({ where: { userId, contactVerifiedAt: { not: null } } });
    return { bot: bots > 0, email: Boolean(user?.emailVerifiedAt) };
  }

  /** The schedule, when it is the caller's or the caller owns the tenant; otherwise not found — never whose it is. */
  private async ownOrOwned(tx: Prisma.TransactionClient, admitted: AdmittedReseller, actor: ResellerActor, id: string): Promise<AnalyticsReportSchedule> {
    const row = await tx.analyticsReportSchedule.findUnique({ where: { id } });
    if (!row || (row.userId !== actor.userId && admitted.as !== 'owner')) throw new ReportRefused('not_found');
    return row;
  }

  /** The analytics door (`analytics.read`), then `work` in the tenant's scope and one transaction. */
  private async door<T>(actor: ResellerActor, tenantId: string, work: (admitted: AdmittedReseller, tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.access.for(ANALYTICS_READ).runFiguresIncludingPlatform(actor, tenantId, 'read', (admitted) => tenantTransaction(this.prisma, (tx) => work(admitted, tx)));
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ReportRefused(e.reason);
      throw e;
    }
  }
}
