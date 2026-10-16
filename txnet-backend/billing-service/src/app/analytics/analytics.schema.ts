import { AnalyticsSaleKind, FulfilmentKind } from '@prisma/client';
import { z } from 'zod';

import { calendarDaySchema as day } from '../request/calendar-day.schema';
import { CALENDARS, COMPARES, MAX_RANGE_DAYS, daysIn } from './analytics-buckets';
import { EXPORT_FORMATS } from './analytics-export';

const queryFields = {
  from: day,
  to: day,
  compare: z.enum(COMPARES).default('previous'),
  calendar: z.enum(CALENDARS).default('gregorian'),
  product: z.string().uuid().optional(),
  panel: z.string().uuid().optional(),
  kind: z.nativeEnum(AnalyticsSaleKind).optional(),
  /** The product's kind (ADR-0148 (3), F-1001-n). */
  fulfilment: z.nativeEnum(FulfilmentKind).optional(),
};

function windowRule(q: { from: string; to: string }, ctx: z.RefinementCtx): void {
  if (q.from > q.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'from_after_to' });
  else if (daysIn(q.from, q.to) > MAX_RANGE_DAYS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'window_too_long' });
}

/**
 * `GET /api/billing/tenants/:tenantId/analytics/<tab>` (F-1001-b): the window
 * in tenant days, both included, at most three years; what it is compared
 * with; the calendar weeks and months are counted in (the reader's language
 * picks it); and the filters. `.strict()`: the tenant is the path's, so a
 * query naming one is refused rather than ignored.
 */
export const analyticsQuerySchema = z.object(queryFields).strict().superRefine(windowRule);

/** The route's query: the tab's, and `format` for a file of the same answer (F-1007-a). */
export const analyticsRequestSchema = z
  .object({ ...queryFields, format: z.enum(EXPORT_FORMATS).optional() })
  .strict()
  .superRefine(windowRule);

export type AnalyticsRequest = z.infer<typeof analyticsRequestSchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/** The tabs answered so far (F-1001-b, F-1001-f, F-1001-h); the rest arrive with their rows. */
export const ANALYTICS_TABS = ['overview', 'sales', 'catalog', 'customers', 'resellers'] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];
