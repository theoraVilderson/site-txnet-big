"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { wheelAdminApi, type WheelDayReport } from "@/lib/engagement-api";
import { formatInstant } from "../../../_lib/datetime";
import { formatMoney } from "../../../_lib/money";
import { DataTable } from "../../../_components/kit/DataTable";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { WHEEL_KEYS, formatDay, plainNumber, refusalKeyOf } from "../../_lib/wheel";
import { WHEEL_SETTINGS_KEYS as K } from "../_lib/wheel-settings";
import { Alert, Field, useMessage } from "./wheel-settings-ui";
import { Button, Input } from "../../../_components/kit";

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("common", K.report.from)}>
          <Input dir="ltr" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t("common", K.report.to)}>
          <Input dir="ltr" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button variant="primary" size="sm" onClick={() => setAsked({ from, to })}>
          {t("common", K.report.show)}
        </Button>
      </div>

      {error ? (
        <Alert>{message(error)}</Alert>
      ) : days === null ? (
        <TableSkeleton rows={3} columns={6} withPagination={false} />
      ) : days.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.report.empty)}</p>
      ) : (
        <DataTable
          label={t("common", K.report.title)}
          rows={days}
          rowKey={(d) => d.day}
          minWidth="min-w-[760px]"
          rowClassName="align-top"
          columns={[
            { id: "day", header: t("common", K.report.day), cell: (d) => formatDay(d.day, lang), className: "font-bold text-text-primary" },
            { id: "version", header: t("common", K.report.version), cell: (d) => d.version },
            { id: "spins", header: t("common", K.report.spins), cell: (d) => d.spins },
            { id: "nothing", header: t("common", K.report.nothing), cell: (d) => d.nothing },
            {
              id: "prizes",
              header: t("common", K.report.prizesGiven),
              cell: (d) =>
                d.prizes
                  .filter((p) => p.count > 0)
                  .map((p) => (
                    <div key={p.prizeId} dir="auto">
                      {p.label} × {p.count} · {formatMoney(p.cost, d.currencyCode, { lang, t })}
                    </div>
                  )),
              className: "text-xs",
              hideOnCard: true,
            },
            {
              id: "refusals",
              header: t("common", K.report.refusals),
              cell: (d) =>
                d.refused > 0 &&
                Object.entries(d.refusals).map(([reason, n]) => (
                  <div key={reason}>
                    {t("common", refusalKeyOf(reason) ?? WHEEL_KEYS.notEligible)} × {n}
                  </div>
                )),
              className: "text-xs",
              hideOnCard: true,
            },
            {
              id: "spent",
              header: t("common", K.report.spent),
              cell: (d) => {
                const money = (a: string) => formatMoney(a, d.currencyCode, { lang, t });
                return (
                  <>
                    <div className="font-bold text-text-primary">
                      {money(d.costSpent)} / {money(d.cap)}
                    </div>
                    <div className="text-text-secondary">{t("common", K.report.capUsed, { percent: plainNumber(d.capUsedPercent) })}</div>
                    {d.alertedAt && <div className="text-text-secondary">{t("common", K.report.alerted, { time: formatInstant(d.alertedAt, lang) ?? "" })}</div>}
                  </>
                );
              },
              className: "text-xs",
            },
          ]}
        />
      )}
    </div>
  );
}
