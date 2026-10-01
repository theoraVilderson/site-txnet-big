"use client";

import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { resellerLimitReachedOf } from "@/lib/reseller-limits";

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
 *
 * One refusal is said here rather than by the service: `reseller_limit_reached`
 * (F-019-s) comes from billing and tenant alike with only figures, so the
 * limit's name — the one the limits pages use — and both numbers are put
 * together once, for every screen that can be refused by one.
 */
export function useApiErrorMessage(): (e: unknown) => string {
  const { t } = useLocale();
  return (e: unknown): string => {
    const limit = resellerLimitReachedOf(e);
    if (limit) {
      const name = t("common", C.resellers.limits.keys[limit.key].name);
      return t("common", C.errors.resellerLimitReached, { name, used: limit.used, limit: limit.limit });
    }
    if (e instanceof ApiError && !e.unreachable) return e.message;
    return t("common", C.errors.unreachable);
  };
}
