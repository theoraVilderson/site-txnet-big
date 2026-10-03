"use client";

import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { refusalKey } from "../_lib/wheel-settings";

// The field and button styles are the catalog page's; they hold no catalog rule.
export { Alert, Field, input, primaryButton, quietButton } from "../../../catalog/_components/catalog-ui";

/** The refusal's own sentence, else the generic answer for that error. */
export function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/** The tenant day after `day` (`YYYY-MM-DD`): when a save starts. */
export function dayAfter(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
