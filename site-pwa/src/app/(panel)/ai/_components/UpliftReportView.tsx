"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { AI_ACTION_TYPES, aiAdminApi, type AiActionType, type UpliftArm, type UpliftReport } from "@/lib/ai-api";
import { DataTable } from "../../_components/kit/DataTable";
import { formatMoney } from "../../_lib/money";
import { K, card } from "./ai-ui";

const PERIOD_DAYS = 30;
const DAY_MS = 86_400_000;

const pct = (rate: number | null) => (rate === null ? "—" : `${rate > 0 ? "+" : ""}${Math.round(rate * 100)}%`);
const isType = (x: string): x is AiActionType => (AI_ACTION_TYPES as readonly string[]).includes(x);

/**
 * The uplift report (F-038-i) for the last 30 days: per type, the customers
 * who got suggestions against the holdout, and the difference. Revenue is per
 * currency, never summed across two (C-02).
 */
export function UpliftReportView() {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [report, setReport] = useState<UpliftReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const to = new Date();
    const from = new Date(to.getTime() - PERIOD_DAYS * DAY_MS);
    aiAdminApi
      .uplift(from.toISOString(), to.toISOString())
      .then((r) => alive && setReport(r))
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <p role="alert" className="text-xs font-medium text-error">{error}</p>;
  if (!report) return <p className="text-sm text-text-secondary">{t("common", K.loading)}</p>;

  const arm = (a: UpliftArm) => t("common", K.report.converted, { converted: a.converted, units: a.units });

  return (
    <section className={`${card} flex flex-col gap-4`}>
      <p className="text-xs text-text-secondary">{t("common", K.report.period, { days: PERIOD_DAYS })}</p>
      {report.types.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.report.none)}</p>
      ) : (
        <DataTable
          label={t("common", K.tabs.report)}
          bare
          rows={report.types}
          rowKey={(row) => row.actionType}
          columns={[
            { id: "type", header: t("common", K.report.type), cell: (row) => (isType(row.actionType) ? t("common", K.types[row.actionType]) : row.actionType), className: "font-bold" },
            { id: "suggested", header: t("common", K.report.suggested), cell: (row) => arm(row.treated) },
            { id: "holdout", header: t("common", K.report.holdout), cell: (row) => arm(row.control) },
            { id: "uplift", header: t("common", K.report.uplift), cell: (row) => pct(row.uplift.rate), dir: "ltr" },
            { id: "revenue", header: t("common", K.report.revenue), cell: (row) => row.uplift.revenue.map((m) => formatMoney(m.amount, m.currencyCode, { lang, t })).join(" · ") || "—" },
          ]}
        />
      )}
      <p className="text-xs text-text-secondary">{t("common", K.report.renewals, { treated: report.renewals.treated, control: report.renewals.control })}</p>
    </section>
  );
}
