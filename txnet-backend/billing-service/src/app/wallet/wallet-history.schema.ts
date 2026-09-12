import { LedgerDirection, PaymentStatus, WalletReasonType } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The financial page's filters (F-092-n), as query parameters.
 *
 * **The range arrives as instants, not as dates on a calendar.** The panel owns
 * the calendar: a Persian user picks a Jalali date and an English one a
 * Gregorian date, both in their own time zone, and the picker resolves that to
 * the start and the end of the day before it asks. A service that took
 * `1405/06/10` would have to hold a calendar and guess a time zone to know when
 * that day began — and would answer a different page for two users who picked
 * the same day. So the wire is ISO-8601 and the calendar is a display concern,
 * the way every other instant on this platform is (F-093-b renders it back).
 */
const instant = (key: string) => z.coerce.date({ message: key });

/** A repeatable query parameter: express gives one value as a string and several as an array. */
const many = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]), z.array(item));

const paging = {
  page: z.coerce.number({ message: E.pageInvalid }).int().positive().default(1),
  pageSize: z.coerce.number({ message: E.pageInvalid }).int().positive().max(100).default(10),
};

export const walletHistorySchema = z
  .object({
    ...paging,
    /** One or more reason types. Intersected with `search`, never replaced by it. */
    types: many(z.nativeEnum(WalletReasonType, { message: E.historyFilterInvalid })).optional(),
    direction: z.nativeEnum(LedgerDirection, { message: E.historyFilterInvalid }).optional(),
    from: instant(E.historyRangeInvalid).optional(),
    to: instant(E.historyRangeInvalid).optional(),
    /** Matched against the translated label of each reason type, folded (`persian-search.ts`). */
    search: z.string({ message: E.historyFilterInvalid }).max(120, { message: E.historyFilterInvalid }).optional(),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: E.historyRangeInvalid,
    path: ['from'],
  });

export const walletPaymentsSchema = z
  .object({
    ...paging,
    statuses: many(z.nativeEnum(PaymentStatus, { message: E.historyFilterInvalid })).optional(),
    from: instant(E.historyRangeInvalid).optional(),
    to: instant(E.historyRangeInvalid).optional(),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: E.historyRangeInvalid,
    path: ['from'],
  });

export type WalletHistoryQuery = z.infer<typeof walletHistorySchema>;
export type WalletPaymentsQuery = z.infer<typeof walletPaymentsSchema>;
