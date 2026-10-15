import { AnalyticsSaleKind } from '@prisma/client';
import { z } from 'zod';

import { CALENDARS, COMPARES, MAX_RANGE_DAYS, daysIn } from './analytics-buckets';

/** A calendar date as `YYYY-MM-DD` that names a real day. */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'not_a_day');

/**
 * `GET /api/billing/tenants/:tenantId/analytics/<tab>` (F-1001-b): the window
 * in tenant days, both included, at most three years; what it is compared
 * with; the calendar weeks and months are counted in (the reader's language
 * picks it); and the filters. `.strict()`: the tenant is the path's, so a
 * query naming one is refused rather than ignored.
 */
export const analyticsQuerySchema = z
  .object({
    from: day,
    to: day,
    compare: z.enum(COMPARES).default('previous'),
    calendar: z.enum(CALENDARS).default('gregorian'),
    product: z.string().uuid().optional(),
    panel: z.string().uuid().optional(),
    kind: z.nativeEnum(AnalyticsSaleKind).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.from > q.to) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'from_after_to' });
    else if (daysIn(q.from, q.to) > MAX_RANGE_DAYS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'window_too_long' });
  });

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/** The tabs F-1001-b answers; the rest arrive with their rows. */
export const ANALYTICS_TABS = ['overview', 'sales', 'catalog'] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];
