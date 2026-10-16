"use client";

import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsResellers } from "@/lib/billing/analytics";
import { Card, CardHeader, DataTable } from "../../_components/kit";
import { TOP_RESELLERS } from "../_lib/resellers";
import { useResellerColumns } from "./ResellersTab";

const R = FrontendI18nKeys.common.analytics.resellers;

/**
 * The Overview's top resellers (F-1001-i, panel-web `contract.analytics.md`
 * Overview item 6): the five largest by net with their sparklines, and the
 * way to the whole leaderboard. The platform's staff only — the view decides.
 */
export function TopResellers({ resellers, currency, allHref }: { resellers: AnalyticsResellers; currency: string; allHref: string }) {
  const { t } = useLocale();
  const columns = useResellerColumns(currency, true);
  return (
    <Card padding="sm">
      <CardHeader
        title={t("common", R.top.title)}
        actions={
          <Link href={allHref} scroll={false} className="text-sm font-semibold text-primary hover:underline">
            {t("common", R.top.all)}
          </Link>
        }
        className="mb-2"
      />
      <DataTable label={t("common", R.top.title)} rows={resellers.resellers.slice(0, TOP_RESELLERS)} columns={columns} rowKey={(r) => r.resellerId} empty={<p className="p-4 text-sm text-text-secondary">{t("common", R.empty)}</p>} compact bare />
    </Card>
  );
}
