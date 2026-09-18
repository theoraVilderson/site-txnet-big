"use client";

import { Ban } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { usePanelTenantClosed } from "../_context/PanelRealtimeContext";

const S = FrontendI18nKeys.common.shell.tenantClosed;

/**
 * "This service has been closed" once the gateway closed the panel's socket
 * with `4403` — the tenant was terminated (F-018-r, F-018-ac).
 *
 * Mounted at the layout, beside the one socket, so it shows on any screen.
 * Not dismissable: nothing reconnects after `4403`, so live updates stay
 * stopped for as long as the tab is open, and the page should not look as if
 * they had not. The sentence is the panel's own — a close code does not pass
 * through `locale-service`.
 */
export function TenantClosedBanner() {
  const { t } = useLocale();
  if (!usePanelTenantClosed()) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-4 top-4 z-50 mx-auto flex max-w-md items-start gap-3 rounded-2xl border border-error-border bg-error-bg p-4 shadow-xl"
    >
      <Ban size={20} aria-hidden className="mt-0.5 shrink-0 text-error" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-bold text-error">{t("common", S.title)}</p>
        <p className="mt-0.5 text-text-secondary">{t("common", S.body)}</p>
      </div>
    </div>
  );
}
