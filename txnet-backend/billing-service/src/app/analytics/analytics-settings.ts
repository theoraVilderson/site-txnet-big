import type { Prisma } from '@prisma/client';
import { z } from 'zod';

/** A renewal counts this many days before or after a term's end, until a tenant sets its own (user, 2026-10-06). */
export const RENEWAL_WINDOW_DEFAULT_DAYS = 7;
/** The widest window a tenant may set; the rollup keeps every renewal this close, so any window re-states without a rebuild. */
export const RENEWAL_WINDOW_MAX_DAYS = 30;

/** `PUT …/analytics/settings` (F-1001-f): the renewal window, whole days 1..30. */
export const renewalWindowSchema = z.object({ renewalWindowDays: z.number().int().min(1).max(RENEWAL_WINDOW_MAX_DAYS) }).strict();
export type RenewalWindowBody = z.infer<typeof renewalWindowSchema>;

/** The renewal window of the tenant `tx` is scoped to (RLS: its row is the only one it sees): its own, else the default. */
export async function renewalWindowOf(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.analyticsSetting.findFirst({ select: { renewalWindowDays: true } });
  return row?.renewalWindowDays ?? RENEWAL_WINDOW_DEFAULT_DAYS;
}
