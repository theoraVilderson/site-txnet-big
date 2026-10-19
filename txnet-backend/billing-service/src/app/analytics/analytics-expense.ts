import { GeneralExpenseCategory } from '@prisma/client';
import { AdmittedReseller, MONEY_PATTERN, ResellerAccessRejection } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { calendarDaySchema } from '../request/calendar-day.schema';

/** The longest an expense is spread over: five years, past any equipment's or lease's life a tenant would book (F-1001-t). */
export const EXPENSE_MAX_MONTHS = 60;
/** The longest note a person writes beside an expense: a label, not a document. */
export const EXPENSE_NOTE_MAX = 200;
/** The most expenses one list answers, newest first; `before` pages further (C-28). */
export const EXPENSES_SHOWN = 50;

/**
 * `POST …/analytics/expenses` (F-1001-t, contract.analytics-expenses.md): what
 * was paid, a decimal string (C-02) above zero, in a currency, on a tenant
 * day, its category, and the months it is spread over (default 1). There is
 * no edit: a mistake is taken back and added again.
 */
export const expenseSchema = z
  .object({
    category: z.nativeEnum(GeneralExpenseCategory),
    amount: z.string().regex(MONEY_PATTERN).refine((a) => /[1-9]/.test(a), 'not_above_zero'),
    currencyCode: z.string().regex(/^[A-Z]{3,5}$/),
    spentOn: calendarDaySchema,
    months: z.number().int().min(1).max(EXPENSE_MAX_MONTHS).default(1),
    note: z.string().trim().min(1).max(EXPENSE_NOTE_MAX).optional(),
  })
  .strict();
export type ExpenseBody = z.infer<typeof expenseSchema>;

/** `GET …/analytics/expenses?before=<id>`: the page after the expense named. */
export const expenseListSchema = z.object({ before: z.string().uuid().optional() }).strict();
export type ExpenseListQuery = z.infer<typeof expenseListSchema>;

export type ExpenseRefusal = ResellerAccessRejection | 'not_found' | 'already_taken_back' | 'currency_not_registered' | 'amount_finer_than_currency' | 'spent_in_future';

export class ExpenseRefused extends Error {
  constructor(readonly reason: ExpenseRefusal) {
    super(reason);
    this.name = 'ExpenseRefused';
  }
}

/** One expense as answered: money as a decimal string; `takenBackAt` set once it no longer counts. */
export type ExpenseView = {
  id: string;
  category: GeneralExpenseCategory;
  amount: string;
  currencyCode: string;
  spentOn: string;
  months: number;
  note: string | null;
  createdByUserId: string | null;
  createdAt: string;
  takenBackAt: string | null;
};

/**
 * The ledger is its own tenant's only (F-1001-t): its owner and members, and
 * on the platform's own tenant its staff. The platform's staff, let in to a
 * reseller's figures by the analytics door, never read or write the
 * reseller's expenses — what a reseller spends is not a report about it. Read
 * from how the door admitted, not the session's tenant: a reseller's owner
 * signs in on the platform's.
 */
export function ownLedgerOnly(admitted: Pick<AdmittedReseller, 'as' | 'platform'>): void {
  if (admitted.as === 'staff' && !admitted.platform) throw new ExpenseRefused('not_allowed');
}
