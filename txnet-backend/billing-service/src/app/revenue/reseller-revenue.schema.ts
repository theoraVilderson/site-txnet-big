import { z } from 'zod';

/** The window a request gets when it names none: the month a reseller is asked about most. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * The longest window one call may total. Both aggregates scan a tenant's whole
 * ledger over the period, so an unbounded `from` is a way to ask the database
 * for every row this reseller ever wrote, once per request. A year is longer
 * than any figure the bot shows and long enough for an annual total.
 */
export const MAX_WINDOW_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `GET /api/billing/tenants/:tenantId/revenue` (F-311-b): the period to total.
 *
 * Both ends are optional and resolved here rather than in the service, so the
 * answer's `from`/`to` are the window that was actually used — the bot renders
 * the dates it was given instead of restating the ones it sent.
 *
 * `.strict()` for the reason every reseller-named surface has it: the tenant is
 * the path's, so a query naming one is refused rather than ignored.
 */
export const revenuePeriodSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict()
  .transform((q, ctx) => {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
    if (from.getTime() > to.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'from_after_to' });
      return z.NEVER;
    }
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'window_too_long' });
      return z.NEVER;
    }
    return { from, to };
  });

export type RevenuePeriodQuery = z.infer<typeof revenuePeriodSchema>;
