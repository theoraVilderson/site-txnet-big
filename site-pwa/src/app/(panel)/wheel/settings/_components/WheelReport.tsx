"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { wheelAdminApi, type WheelDayReport } from "@/lib/engagement-api";
import { formatInstant } from "../../../_lib/datetime";
import { formatMoney } from "../../../_lib/money";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { WHEEL_KEYS, formatDay, plainNumber, refusalKeyOf } from "../../_lib/wheel";
import { WHEEL_SETTINGS_KEYS as K } from "../_lib/wheel-settings";
import { Alert, Field, input, primaryButton, useMessage } from "./wheel-settings-ui";

/**
 * The day report (F-707-e): per tenant day, spins, refusals by reason, prizes
 * given and the cost against the cap. Days are the tenant's, typed as
 * `YYYY-MM-DD`; billing holds the range to 31 days.
 */
export function WheelReport({ today }: { today: string | null }) {
  const { lang, t } = useLocale();
  const message = useMessage();
  const [from, setFrom] = useState(today ?? "");
  const [to, setTo] = useState(today ?? "");
  const [asked, setAsked] = useState({ from: today ?? "", to: today ?? "" });
  const [days, setDays] = useState<WheelDayReport[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    setDays(null);
    setError(null);
    wheelAdminApi.report({ from: asked.from || undefined, to: asked.to || undefined }).then(
      (d) => alive && setDays(d),
      (e) => {
        if (!alive) return;
        setDays([]);
        setError(e);
      },
    );
    return () => {
      alive = false;
    };
  }, [asked]);

  const cell = "px-3 py-2 text-start align-top";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("common", K.report.from)}>
          <input className={input} dir="ltr" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t("common", K.report.to)}>
          <input className={input} dir="ltr" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <button type="button" className={primaryButton} onClick={() => setAsked({ from, to })}>
          {t("common", K.report.show)}
        </button>
      </div>

      {error ? (
        <Alert>{message(error)}</Alert>
      ) : days === null ? (
        <TableSkeleton rows={3} columns={6} withPagination={false} />
      ) : days.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.report.empty)}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-card-border bg-card-bg">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-[11px] text-text-secondary">
              <tr>
                <th className={cell}>{t("common", K.report.day)}</th>
                <th className={cell}>{t("common", K.report.version)}</th>
                <th className={cell}>{t("common", K.report.spins)}</th>
                <th className={cell}>{t("common", K.report.nothing)}</th>
                <th className={cell}>{t("common", K.report.prizesGiven)}</th>
                <th className={cell}>{t("common", K.report.refusals)}</th>
                <th className={cell}>{t("common", K.report.spent)}</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const money = (a: string) => formatMoney(a, d.currencyCode, { lang, t });
                return (
                  <tr key={d.day} className="border-t border-card-border">
                    <td className={`${cell} font-bold text-text-primary`}>{formatDay(d.day, lang)}</td>
                    <td className={cell}>{d.version}</td>
                    <td className={cell}>{d.spins}</td>
                    <td className={cell}>{d.nothing}</td>
                    <td className={`${cell} text-xs`}>
                      {d.prizes.filter((p) => p.count > 0).map((p) => (
                        <div key={p.prizeId} dir="auto">
                          {p.label} × {p.count} · {money(p.cost)}
                        </div>
                      ))}
                    </td>
                    <td className={`${cell} text-xs`}>
                      {d.refused > 0 &&
                        Object.entries(d.refusals).map(([reason, n]) => (
                          <div key={reason}>
                            {t("common", refusalKeyOf(reason) ?? WHEEL_KEYS.notEligible)} × {n}
                          </div>
                        ))}
                    </td>
                    <td className={`${cell} text-xs`}>
                      <div className="font-bold text-text-primary">
                        {money(d.costSpent)} / {money(d.cap)}
                      </div>
                      <div className="text-text-secondary">{t("common", K.report.capUsed, { percent: plainNumber(d.capUsedPercent) })}</div>
                      {d.alertedAt && <div className="text-text-secondary">{t("common", K.report.alerted, { time: formatInstant(d.alertedAt, lang) ?? "" })}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
