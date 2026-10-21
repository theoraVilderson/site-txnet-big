"use client";

import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useLiveReread } from "@/hooks/useLiveReread";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { MIGRATION_EVENTS, MIGRATION_KEYS as K, migrationLiveOf, migrationRefusalKey, reasonKey } from "../../../_lib/migration";

/**
 * Re-reads when one of this reseller's runs moves (C-14, `migrationLiveOf`),
 * on each channel the viewer holds; `runId` narrows to that run. Never polls.
 */
export function useMigrationLive(resellerId: string, reread: () => void, runId?: string) {
  const { me } = usePanelSession();
  const [first, second] = migrationLiveOf(me, resellerId);
  const ours = (p: Record<string, unknown>) => runId === undefined || p.runId === runId;
  useLiveReread(first?.channel ?? null, MIGRATION_EVENTS, reread, (p) => (first?.accepts(p) ?? false) && ours(p));
  useLiveReread(second?.channel ?? null, MIGRATION_EVENTS, reread, (p) => (second?.accepts(p) ?? false) && ours(p));
}

/** A refusal's own sentence, else the generic answer for that error. */
export function useMigrationMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = migrationRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/** Why a preview sent the run back, as a sentence; a reason this build does not know is shown as its code. */
export function useFailureText() {
  const { t } = useLocale();
  return (reason: string) => {
    const key = reasonKey(K.failure, reason);
    return key ? t("common", key) : t("common", K.failure.other, { reason });
  };
}
