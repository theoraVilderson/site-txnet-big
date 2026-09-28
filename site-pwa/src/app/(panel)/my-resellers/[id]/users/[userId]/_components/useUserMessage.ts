"use client";

import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { userRefusalKey } from "../../../../_lib/users";

/** The door's own sentence (`USER_REFUSAL_KEYS`), else the generic answer for that error. */
export function useUserMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = userRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}
