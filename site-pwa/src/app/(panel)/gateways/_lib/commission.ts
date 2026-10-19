import type { CommissionBody } from "@/lib/billing-api";
import { MONEY_PATTERN } from "../../_lib/money";

/**
 * The provider-commission form (F-1001-w; billing
 * `contract.analytics-expenses.md` "Gateway commission"): the body billing
 * takes, checked as its schema checks it, so the section says what is wrong
 * before asking. A blank percent or fixed amount is 0 — a provider that takes
 * only one of the two is the usual case.
 */

/** The form as typed: text, so nothing is rounded on the way (C-02). */
export type CommissionForm = { percent: string; fixedAmount: string; effectiveFrom: string | null };

/** Which field stops the body. */
export type CommissionFormError = "percent" | "fixedAmount" | "effectiveFrom";

/** A percent at the column's four places — billing's `PERCENT_PATTERN`. */
const PERCENT_PATTERN = /^(0|[1-9]\d{0,2})(\.\d{1,4})?$/;
const PERCENT_MAX = 100;

/** The body to send — or the first field billing would refuse. */
export function commissionBodyOf(form: CommissionForm): { body: CommissionBody } | { error: CommissionFormError } {
  const percent = form.percent.trim() || "0";
  const fixedAmount = form.fixedAmount.trim() || "0";
  if (!PERCENT_PATTERN.test(percent) || Number(percent) > PERCENT_MAX) return { error: "percent" };
  if (!MONEY_PATTERN.test(fixedAmount)) return { error: "fixedAmount" };
  if (!form.effectiveFrom) return { error: "effectiveFrom" };
  return { body: { percent, fixedAmount, effectiveFrom: form.effectiveFrom } };
}
