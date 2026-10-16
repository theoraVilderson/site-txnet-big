// A person's scheduled analytics reports (F-1006-a, billing/contract.analytics-reports.md).
import type { AnalyticsCalendar, AnalyticsTab } from "./analytics";
import { call } from "./client";

/** How often a report goes — billing's `REPORT_FREQUENCIES`. */
export const REPORT_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

/** A tab a report's link may open: every tab but the leaderboard across resellers. */
export type ReportTab = Exclude<AnalyticsTab, "resellers">;

/** A schedule's settings, as billing takes them; `weekday` 0 (Sunday) – 6, a weekly one's only; `hour` on the tenant's clock. */
export interface ReportScheduleBody {
  frequency: ReportFrequency;
  weekday: number | null;
  hour: number;
  calendar: AnalyticsCalendar;
  tab: ReportTab;
  bot: boolean;
  email: boolean;
}

/** A schedule as answered: `mine` false is another person's, seen by the tenant's owner, who may only pause or remove it. */
export interface ReportSchedule extends ReportScheduleBody {
  id: string;
  userId: string;
  paused: boolean;
  nextRunAt: string;
  lastSentAt: string | null;
  mine: boolean;
  /** The person's name, a label; null without one. */
  name: string | null;
}

/** The schedules the caller may see, and where the caller can be reached: a verified chat, a verified address. */
export interface ReportSchedules {
  schedules: ReportSchedule[];
  reach: { bot: boolean; email: boolean };
}

/** A person may hold at most this many — billing's `REPORT_SCHEDULES_PER_PERSON`. */
export const REPORT_SCHEDULES_PER_PERSON = 10;

const base = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/analytics/report-schedules`;
const one = (tenantId: string, id: string) => `${base(tenantId)}/${encodeURIComponent(id)}`;

/** No permission is judged here: billing's door is `analytics.read`, and only the tenant's analytics staff may make one. */
export const reportSchedulesApi = {
  list: (tenantId: string) => call<ReportSchedules>(base(tenantId)),
  create: (tenantId: string, body: ReportScheduleBody) => call<ReportSchedule>(base(tenantId), { method: "POST", body: JSON.stringify(body) }),
  change: (tenantId: string, id: string, body: Partial<ReportScheduleBody> & { paused?: boolean }) =>
    call<ReportSchedule>(one(tenantId, id), { method: "PATCH", body: JSON.stringify(body) }),
  remove: (tenantId: string, id: string) => call<{ removed: true }>(one(tenantId, id), { method: "DELETE" }),
  /** The period that closed before now, sent at once; its next run stays. */
  sendNow: (tenantId: string, id: string) => call<{ sent: true }>(`${one(tenantId, id)}/send`, { method: "POST" }),
};
