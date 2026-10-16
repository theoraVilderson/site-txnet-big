/**
 * A panel's monthly cost form (F-1002-c; network `contract.panel-cost.md`):
 * the body billing takes, checked as billing checks it, so the page says what
 * is wrong before asking.
 */

/** USD as a decimal string, at most two places — billing's `panelCostSchema` (C-02: never a float). */
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;

/** The first day of `today`'s month: the earliest a new price may take effect (rule 2). */
export function firstOpenDay(today: string): string {
  return `${today.slice(0, 8)}01`;
}

/** The body to send, or which field is wrong: `amount`, or `closedMonth` for a day before this month. */
export function panelCostBodyOf(form: { amount: string; from: string }, today: string): { body: { monthlyCostUsd: string; effectiveFrom: string } } | { error: "amount" | "closedMonth" } {
  const amount = form.amount.trim();
  if (!AMOUNT.test(amount)) return { error: "amount" };
  if (form.from < firstOpenDay(today)) return { error: "closedMonth" };
  return { body: { monthlyCostUsd: amount, effectiveFrom: form.from } };
}
