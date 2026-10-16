import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { LOSS_ALERT_DEFAULT_PERCENT, LOSS_ALERT_MAX_PERCENT } from './analytics-loss';

/** A renewal counts this many days before or after a term's end, until a tenant sets its own (user, 2026-10-06). */
export const RENEWAL_WINDOW_DEFAULT_DAYS = 7;
/** The widest window a tenant may set; the rollup keeps every renewal this close, so any window re-states without a rebuild. */
export const RENEWAL_WINDOW_MAX_DAYS = 30;

/**
 * `PUT …/analytics/settings`: the renewal window, whole days 1..30 (F-1001-f),
 * and the loss alert's threshold, whole percent 0..500 (F-1003) — either or
 * both; a write naming neither changes nothing and is refused.
 */
export const analyticsSettingsSchema = z
  .object({
    renewalWindowDays: z.number().int().min(1).max(RENEWAL_WINDOW_MAX_DAYS).optional(),
    lossAlertPercent: z.number().int().min(0).max(LOSS_ALERT_MAX_PERCENT).optional(),
  })
  .strict()
  .refine((b) => b.renewalWindowDays !== undefined || b.lossAlertPercent !== undefined, { message: 'nothing_to_change' });
export type AnalyticsSettingsBody = z.infer<typeof analyticsSettingsSchema>;
/** Every setting as it stands after a write. */
export type AnalyticsSettings = Required<AnalyticsSettingsBody>;

/** The renewal window of the tenant `tx` is scoped to (RLS: its row is the only one it sees): its own, else the default. */
export async function renewalWindowOf(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.analyticsSetting.findFirst({ select: { renewalWindowDays: true } });
  return row?.renewalWindowDays ?? RENEWAL_WINDOW_DEFAULT_DAYS;
}

/** Both settings of the tenant `tx` is scoped to: its own, else the defaults. */
export async function settingsOf(tx: Prisma.TransactionClient): Promise<AnalyticsSettings> {
  const row = await tx.analyticsSetting.findFirst({ select: { renewalWindowDays: true, lossAlertPercent: true } });
  return { renewalWindowDays: row?.renewalWindowDays ?? RENEWAL_WINDOW_DEFAULT_DAYS, lossAlertPercent: row?.lossAlertPercent ?? LOSS_ALERT_DEFAULT_PERCENT };
}
