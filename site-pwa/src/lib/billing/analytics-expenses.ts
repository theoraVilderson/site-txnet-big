// A tenant's general expenses (F-1001-t, billing/contract.analytics-expenses.md).
import { call } from "./client";

/** What an expense was for — billing's `GeneralExpenseCategory`, in its order. */
export const EXPENSE_CATEGORIES = ["equipment", "advertising", "staff", "domain", "rent", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** The longest an expense is spread over, and the longest note — billing's `EXPENSE_MAX_MONTHS` and `EXPENSE_NOTE_MAX`. */
export const EXPENSE_MAX_MONTHS = 60;
export const EXPENSE_NOTE_MAX = 200;

/** A new expense as billing takes it: money a decimal string (C-02), a tenant day, 1..60 months. */
export interface ExpenseBody {
  category: ExpenseCategory;
  amount: string;
  currencyCode: string;
  spentOn: string;
  months: number;
  note?: string;
}

/** An expense as answered; `takenBackAt` set once it no longer counts. */
export interface Expense extends Required<Omit<ExpenseBody, "note">> {
  id: string;
  note: string | null;
  createdByUserId: string | null;
  createdAt: string;
  takenBackAt: string | null;
}

/** A page of the ledger, newest first; `currencyCode` the tenant's, a new expense's default. */
export interface ExpensePage {
  expenses: Expense[];
  more: boolean;
  currencyCode: string;
}

const base = (tenantId: string) => `/tenants/${encodeURIComponent(tenantId)}/analytics/expenses`;

/** No permission is judged here: billing reads through `analytics.read` and writes through `settings.manage`, its own tenant's only. */
export const expensesApi = {
  list: (tenantId: string, q: { before?: string }) => call<ExpensePage>(q.before ? `${base(tenantId)}?before=${encodeURIComponent(q.before)}` : base(tenantId)),
  add: (tenantId: string, body: ExpenseBody) => call<Expense>(base(tenantId), { method: "POST", body: JSON.stringify(body) }),
  /** No longer counts from the day it was paid; there is no edit. */
  takeBack: (tenantId: string, id: string) => call<Expense>(`${base(tenantId)}/${encodeURIComponent(id)}/take-back`, { method: "POST" }),
};
