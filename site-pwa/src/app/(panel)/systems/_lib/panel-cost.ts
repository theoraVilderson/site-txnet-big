/**
 * A panel's monthly cost form (F-1002-c, its traffic F-1005-b; network `contract.panel-cost.md`):
 * the body billing takes, checked as billing checks it, so the page says what
 * is wrong before asking.
 */

/** USD as a decimal string, at most two places — billing's `panelCostSchema` (C-02: never a float). */
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;

/** The first day of `today`'s month: the earliest a new price may take effect (rule 2). */
export function firstOpenDay(today: string): string {
  return `${today.slice(0, 8)}01`;
}

/** The month's traffic in whole gigabytes — at most 9,999,999 (about 9.5 PB), never 0: none is left blank. */
const TRAFFIC_GB = /^[1-9]\d{0,6}$/;
/** A gigabyte as the page writes sizes (`formatBytes`, 1024-based), so what is typed is what is shown back. */
const BYTES_PER_GB = BigInt(1024) ** BigInt(3);

export type PanelCostBody = { monthlyCostUsd: string; monthlyTrafficBytes?: string; effectiveFrom: string };

/**
 * The body to send, or which field is wrong: `amount`, `traffic` (F-1005-a:
 * the month's traffic the price buys, optional), or `closedMonth` for a day
 * before this month.
 */
export function panelCostBodyOf(form: { amount: string; trafficGb?: string; from: string }, today: string): { body: PanelCostBody } | { error: "amount" | "traffic" | "closedMonth" } {
  const amount = form.amount.trim();
  const traffic = form.trafficGb?.trim() ?? "";
  if (!AMOUNT.test(amount)) return { error: "amount" };
  if (traffic !== "" && !TRAFFIC_GB.test(traffic)) return { error: "traffic" };
  if (form.from < firstOpenDay(today)) return { error: "closedMonth" };
  return { body: { monthlyCostUsd: amount, ...(traffic ? { monthlyTrafficBytes: (BigInt(traffic) * BYTES_PER_GB).toString() } : {}), effectiveFrom: form.from } };
}
