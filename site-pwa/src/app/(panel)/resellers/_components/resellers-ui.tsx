"use client";

import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { refusalKey } from "../_lib/resellers";

// The sheet, field and button styles are the catalog page's; they hold no
// catalog rule, and a second copy would drift.
export { Alert, Field, Sheet, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";

/** The refusal's own sentence, else the generic answer for that error. */
export function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}
