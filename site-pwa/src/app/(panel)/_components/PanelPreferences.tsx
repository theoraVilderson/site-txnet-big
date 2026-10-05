"use client";

import { useEffect } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { onUiPreferencesWriteFailed, useUiPreferences } from "@/stores/ui-preferences-store";
import { usePanelSession } from "../_context/PanelSessionContext";
import { notify } from "./kit/notify";

/**
 * Loads the person's display preferences once `/auth/me` has answered, and
 * again for another account after a switch (UX-1-l, `contract.ux.md` P4). A
 * refused write has already been rolled back by the store; this says so.
 * Draws nothing.
 */
export function PanelPreferences() {
  const { t } = useLocale();
  const { me, group } = usePanelSession();
  const userId = me ? (group?.current.userId ?? null) : null;
  const load = useUiPreferences((s) => s.load);

  useEffect(() => {
    if (userId) void load(userId);
  }, [userId, load]);

  useEffect(
    () => onUiPreferencesWriteFailed(() => notify.error(t("common", FrontendI18nKeys.common.shell.preferenceNotSaved))),
    [t],
  );

  return null;
}
