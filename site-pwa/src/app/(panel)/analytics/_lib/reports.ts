import type { AnalyticsCalendar } from "@/lib/billing/analytics";
import type { ReportFrequency, ReportScheduleBody, ReportTab } from "@/lib/billing/analytics-reports";

/**
 * The Reports tab's form (F-1006-b; billing `contract.analytics-reports.md`):
 * the body billing takes, checked as its CHECKs check it, so the page says
 * what is wrong before asking.
 */

export type ReportForm = { frequency: ReportFrequency; weekday: number; hour: number; tab: ReportTab; bot: boolean; email: boolean };

/** A morning hour is when a closed day is read; Monday is the first weekday `Intl` names in most calendars. */
export const DEFAULT_REPORT_FORM: ReportForm = { frequency: "daily", weekday: 1, hour: 9, tab: "overview", bot: true, email: false };

const HOURS_IN_DAY = 24;
const DAYS_IN_WEEK = 7;
export const REPORT_HOURS = Array.from({ length: HOURS_IN_DAY }, (_, h) => h);
export const REPORT_WEEKDAYS = Array.from({ length: DAYS_IN_WEEK }, (_, d) => d);

/** The body to send — a weekday with a weekly report only, the reader's calendar for a month — or why not. */
export function reportBodyOf(form: ReportForm, calendar: AnalyticsCalendar): { body: ReportScheduleBody } | { error: "noChannel" } {
  if (!form.bot && !form.email) return { error: "noChannel" };
  return { body: { ...form, weekday: form.frequency === "weekly" ? form.weekday : null, calendar } };
}

/** A weekday's name in the language (0 = Sunday): 2026-10-18 was a Sunday, and `Intl` names it. */
export function weekdayName(day: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 18 + day)));
}

/** An hour on the clock in the language, `09:00`. */
export function hourName(hour: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour)));
}
