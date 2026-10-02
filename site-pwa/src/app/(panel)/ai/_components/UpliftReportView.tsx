"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { AI_ACTION_TYPES, aiAdminApi, type AiActionType, type UpliftArm, type UpliftReport } from "@/lib/ai-api";
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
        <div className="overflow-x-auto">
          <table className="w-full text-start text-sm">
            <thead className="text-xs text-text-secondary">
              <tr>
                <th className="p-2 text-start">{t("common", K.report.type)}</th>
                <th className="p-2 text-start">{t("common", K.report.suggested)}</th>
                <th className="p-2 text-start">{t("common", K.report.holdout)}</th>
                <th className="p-2 text-start">{t("common", K.report.uplift)}</th>
                <th className="p-2 text-start">{t("common", K.report.revenue)}</th>
              </tr>
            </thead>
            <tbody>
              {report.types.map((row) => (
                <tr key={row.actionType} className="border-t border-card-border">
                  <td className="p-2 font-bold">{isType(row.actionType) ? t("common", K.types[row.actionType]) : row.actionType}</td>
                  <td className="p-2">{arm(row.treated)}</td>
                  <td className="p-2">{arm(row.control)}</td>
                  <td className="p-2" dir="ltr">{pct(row.uplift.rate)}</td>
                  <td className="p-2">{row.uplift.revenue.map((m) => formatMoney(m.amount, m.currencyCode, { lang, t })).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-text-secondary">{t("common", K.report.renewals, { treated: report.renewals.treated, control: report.renewals.control })}</p>
    </section>
  );
}
