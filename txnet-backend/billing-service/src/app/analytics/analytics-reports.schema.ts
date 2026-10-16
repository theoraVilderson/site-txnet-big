import { z } from 'zod';

import { CALENDARS } from './analytics-buckets';
import { REPORT_FREQUENCIES } from './analytics-report-clock';
import { ANALYTICS_TABS, AnalyticsTab } from './analytics.schema';

/**
 * A scheduled report's body (F-1006-a, contract.analytics-reports.md
 * "Routes"). The tab is the one its link opens — never the leaderboard across
 * resellers, which is no person's own figures. `.strict()`: the person and
 * the tenant are the session's and the path's, never the body's.
 */
export type ReportTab = Exclude<AnalyticsTab, 'resellers'>;
/** A stored tab read back: one of today's tabs, and one a report may open. */
export const isReportTab = (tab: string): tab is ReportTab => tab !== 'resellers' && ANALYTICS_TABS.some((t) => t === tab);

const WEEKDAY_MAX = 6;
const HOUR_MAX = 23;

const fields = {
  frequency: z.enum(REPORT_FREQUENCIES),
  /** 0 (Sunday) – 6; a weekly report's only. */
  weekday: z.number().int().min(0).max(WEEKDAY_MAX).nullable().optional(),
  /** On the tenant's clock (TZ-1). */
  hour: z.number().int().min(0).max(HOUR_MAX),
  /** The reader's calendar, as the page's: a monthly report's month is cut in it. */
  calendar: z.enum(CALENDARS),
  tab: z.string().refine(isReportTab, 'not_a_report_tab'),
  bot: z.boolean(),
  email: z.boolean(),
};

type Timing = { frequency?: string; weekday?: number | null; bot?: boolean; email?: boolean };

/** A weekly report names its day and only a weekly one does; a report goes somewhere. The table's CHECKs, said first. */
function rules(b: Timing, ctx: z.RefinementCtx): void {
  if (b.frequency !== undefined && (b.frequency === 'weekly') !== (b.weekday !== undefined && b.weekday !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['weekday'], message: 'weekday_for_weekly_only' });
  }
  if (b.bot === false && b.email === false) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bot'], message: 'no_channel' });
}

export const reportScheduleSchema = z.object(fields).strict().superRefine(rules);
export type ReportScheduleBody = z.infer<typeof reportScheduleSchema>;

/**
 * A change: any field, or `paused`. A timing change names its frequency and
 * weekday together, so the pair is judged whole.
 */
export const reportScheduleChangeSchema = z
  .object({ ...fields, paused: z.boolean() })
  .partial()
  .strict()
  .superRefine((b, ctx) => {
    if (Object.keys(b).length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'nothing_to_change' });
    if (b.weekday !== undefined && b.frequency === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['frequency'], message: 'weekday_needs_frequency' });
    rules(b, ctx);
  });
export type ReportScheduleChange = z.infer<typeof reportScheduleChangeSchema>;
