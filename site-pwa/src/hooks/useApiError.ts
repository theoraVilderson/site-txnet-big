"use client";

import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";

import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The `common` namespace as generated constants (F-083, C-06). */
const C = FrontendI18nKeys.common;

/**
 * Turns anything a failed call threw into one line the user can read.
 *
 * An `auth-api` answer is already in the user's language, so it is shown
 * unchanged — restating it locally would mean this panel keeping a second copy
 * of every message the service owns. Only the cases with no server text (the
 * request never arrived, or a bug threw here) get a string of this panel's own.
 */
export function useApiErrorMessage(): (e: unknown) => string {
  const { t } = useLocale();
  return (e: unknown): string => {
    if (e instanceof ApiError && !e.unreachable) return e.message;
    return t("common", C.errors.unreachable);
  };
}
