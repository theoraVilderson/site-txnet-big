"use client";

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ANALYTICS_EXPORT_FORMATS, type AnalyticsExportFormat, type AnalyticsQuery, type AnalyticsTab, exportAnalytics } from "@/lib/billing/analytics";
import { Button, Menu, notify } from "../../_components/kit";
import { downloadBlob } from "../../_lib/download";

const K = FrontendI18nKeys.common.analytics.export;

/**
 * The Export menu in the `/analytics` header (F-1007-b, panel-web
 * `contract.analytics.md` "Header"): the tab and filters on screen as CSV or
 * Excel, from billing's export (F-1007-a) — the same door, scope and under-5
 * rule as the page. A refusal (a rebuild, a key taken away) is a toast in its
 * own words.
 */
export function ExportMenu({ tenantId, tab, query }: { tenantId: string | null; tab: AnalyticsTab; query: AnalyticsQuery }) {
  const { t } = useLocale();
  const errorText = useApiErrorMessage();
  const [busy, setBusy] = useState(false);

  const save = async (format: AnalyticsExportFormat) => {
    if (!tenantId) return;
    setBusy(true);
    try {
      const file = await exportAnalytics(tenantId, tab, query, format);
      downloadBlob(file.fileName || `analytics-${tab}-${query.from}-${query.to}.${format}`, file.blob);
    } catch (e) {
      notify.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu
      label={t("common", K.button)}
      trigger={
        // The kit's icon slots, so the icon is sized and spaced as every button's; the chevron says it opens a menu.
        <Button variant="secondary" size="md" loading={busy} disabled={!tenantId} icon={<Download size={16} aria-hidden />} iconEnd={<ChevronDown size={14} aria-hidden className="text-text-secondary" />}>
          {t("common", K.button)}
        </Button>
      }
      items={ANALYTICS_EXPORT_FORMATS.map((format) => ({ id: format, label: t("common", K[format]), onSelect: () => void save(format), disabled: busy }))}
    />
  );
}
