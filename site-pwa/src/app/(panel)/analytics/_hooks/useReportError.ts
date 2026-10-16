"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";

const R = FrontendI18nKeys.common.analytics.reports.refusals;

/** Billing's report refusals (billing `contract.analytics-reports.md` "Routes") in the page's words. */
const REFUSALS: Readonly<Record<string, string>> = {
  not_allowed: R.notAllowed,
  too_many_schedules: R.tooMany,
  rebuilding: R.rebuilding,
};

/** A report action's failure as a sentence: billing's reason in words, else the page's generic reading. */
export function useReportError(): (e: unknown) => string {
  const { t } = useLocale();
  const generic = useApiErrorMessage();
  return (e) => {
    const key = e instanceof ApiError && e.reason ? REFUSALS[e.reason] : undefined;
    return key ? t("common", key) : generic(e);
  };
}
