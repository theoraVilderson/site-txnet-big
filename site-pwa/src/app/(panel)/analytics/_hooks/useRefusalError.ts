"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";

const A = FrontendI18nKeys.common.analytics;
const R = A.reports.refusals;
const E = A.expenses.refusals;

/** Billing's report refusals (billing `contract.analytics-reports.md` "Routes") in the page's words. */
const REPORT_REFUSALS: Readonly<Record<string, string>> = {
  not_allowed: R.notAllowed,
  too_many_schedules: R.tooMany,
  rebuilding: R.rebuilding,
};

/** Billing's expense refusals (billing `contract.analytics-expenses.md` "Routes") in the page's words. */
const EXPENSE_REFUSALS: Readonly<Record<string, string>> = {
  not_allowed: E.notAllowed,
  not_found: E.notFound,
  already_taken_back: E.alreadyTakenBack,
  currency_not_registered: E.currencyNotRegistered,
  amount_finer_than_currency: E.amountFinerThanCurrency,
  spent_in_future: E.spentInFuture,
};

/** An action's failure as a sentence: billing's reason in words from `refusals`, else the page's generic reading. */
function useRefusalError(refusals: Readonly<Record<string, string>>): (e: unknown) => string {
  const { t } = useLocale();
  const generic = useApiErrorMessage();
  return (e) => {
    const key = e instanceof ApiError && e.reason ? refusals[e.reason] : undefined;
    return key ? t("common", key) : generic(e);
  };
}

/** A report action's failure (F-1006-b). */
export const useReportError = () => useRefusalError(REPORT_REFUSALS);
/** An expense action's failure (F-1001-u). */
export const useExpenseError = () => useRefusalError(EXPENSE_REFUSALS);
