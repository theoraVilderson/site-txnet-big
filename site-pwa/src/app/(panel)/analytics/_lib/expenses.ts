import { EXPENSE_MAX_MONTHS, type ExpenseBody, type ExpenseCategory } from "@/lib/billing/analytics-expenses";
import { MONEY_PATTERN } from "../../_lib/money";

/**
 * The Expenses view's form (F-1001-u; billing `contract.analytics-expenses.md`):
 * the body billing takes, checked as its schema checks it, so the page says
 * what is wrong before asking.
 */

/** The form as typed: the amount and months as text, so nothing is rounded on the way. */
export type ExpenseForm = { category: ExpenseCategory; amount: string; currencyCode: string; spentOn: string | null; months: string; note: string };

/** Which field stops the body. */
export type ExpenseFormError = "amount" | "months" | "spentOn";

const WHOLE_MONTHS = /^[1-9]\d*$/;

/** The body to send — or the first field billing would refuse. `today` is the reader's day: an expense is never paid after it. */
export function expenseBodyOf(form: ExpenseForm, today: string): { body: ExpenseBody } | { error: ExpenseFormError } {
  const amount = form.amount.trim();
  // Above zero: the pattern takes "0" and "0.00", billing's CHECK does not.
  if (!MONEY_PATTERN.test(amount) || !/[1-9]/.test(amount)) return { error: "amount" };
  if (!WHOLE_MONTHS.test(form.months) || Number(form.months) > EXPENSE_MAX_MONTHS) return { error: "months" };
  if (!form.spentOn || form.spentOn > today) return { error: "spentOn" };
  const note = form.note.trim();
  return { body: { category: form.category, amount, currencyCode: form.currencyCode, spentOn: form.spentOn, months: Number(form.months), ...(note ? { note } : {}) } };
}

/**
 * Whether the view may offer the ledger: billing keeps it to its own tenant
 * (contract rule 1) — the session's own, or a reseller's owner on its own
 * workspace; never the platform's staff on a reseller's.
 */
export function expensesVisible(view: { tenantId?: string; self?: boolean }): boolean {
  return !view.tenantId || view.self === true;
}
