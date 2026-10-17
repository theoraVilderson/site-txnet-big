"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { resellerRevenueApi } from "@/lib/billing-api";
import { readAnalytics } from "@/lib/billing/analytics";
import { holdsPermission } from "@/lib/permissions";
import { PANEL_ANALYTICS } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { dayIn } from "../../../_lib/datetime";
import { formatMoney } from "../../../_lib/money";
import { startOfDayIn } from "../../../_lib/widgets";
import { addDays, calendarOf } from "../../../analytics/_lib/filters";
import { heroSeries } from "../../../analytics/_lib/overview";
import { Sparkline } from "../../kit/charts";
import { FooterLink } from "../parts";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;
const DAY_MS = 86_400_000;
/** The sparkline's reach, today included — the widget's longest window. */
const TREND_DAYS = 30;

const WINDOWS = [
  { key: D.revenue.today, from: (now: Date, zone: string | null) => startOfDayIn(now, zone) },
  { key: D.revenue.week, from: (now: Date) => new Date(now.getTime() - 7 * DAY_MS) },
  { key: D.revenue.month, from: (now: Date) => new Date(now.getTime() - 30 * DAY_MS) },
] as const;

/**
 * One labelled figure of the platform's two (UX-1-r3): users, then resellers.
 * The label sits above the amount, never beside it — beside it, a phone's
 * third of a card left the amount a few pixels and it truncated to "$ 6…".
 */
function Line({ label, amount }: { label: string; amount: string }) {
  return (
    <div className="min-w-0 @md:mt-2">
      <span className="block text-2xs text-text-secondary">{label}</span>
      <span className="inline-block whitespace-nowrap text-sm font-black tabular-nums text-text-primary" dir="ltr">
        {amount}
      </span>
    </div>
  );
}

/**
 * Net sales per day over the last 30, in the operating currency, from the
 * analytics overview (F-1001-k) — only for a caller holding `analytics.read`,
 * the key the analytics page opens with. A refusal, a rebuild or a failure is
 * no sparkline, never a failed widget: the totals are the widget's reading.
 */
function useNetTrend(tenantId: string | null, zone: string | null, lang: string, allowed: boolean): (number | null)[] | null {
  const [trend, setTrend] = useState<{ tenantId: string; values: (number | null)[] } | null>(null);
  useEffect(() => {
    if (!tenantId || !allowed) return;
    let live = true;
    const today = dayIn(Date.now(), zone);
    readAnalytics(tenantId, "overview", { from: addDays(today, 1 - TREND_DAYS), to: today, compare: "none", calendar: calendarOf(lang) }).then(
      (a) => live && setTrend(!a.rebuilding && a.currencies[0] ? { tenantId, values: heroSeries(a.series, "net", a.currencies[0]) } : null),
      () => live && setTrend(null),
    );
    return () => {
      live = false;
    };
  }, [tenantId, zone, lang, allowed]);
  return allowed && trend?.tenantId === tenantId ? trend.values : null;
}

/**
 * Revenue (UX-1-r, D5): what the caller's tenant sold today (from midnight in
 * their resolved zone), over 7 and over 30 days — F-311-b's totals, one call
 * per window, each in that tenant's operating currency. A total billing could
 * not convert reads as a dash, never as a sum of two currencies. On the
 * platform's own tenant its users' sales and what it charged its resellers are
 * two lines, never added into one (UX-1-r3). With `analytics.read`, a 30-day
 * sparkline and a link to `/analytics` under them (F-1001-k).
 */
export default function RevenueWidget() {
  const { t, lang } = useLocale();
  const { me, timeZone } = usePanelSession();
  const tenantId = me?.tenant.id ?? null;
  const zone = timeZone?.zone ?? null;
  const canAnalyse = holdsPermission(me?.permissions, "analytics.read");
  const trend = useNetTrend(tenantId, zone, lang, canAnalyse);
  const source = useWidgetSource(
    "revenue",
    async () => {
      if (!tenantId) throw new Error("no tenant");
      const now = new Date();
      const to = now.toISOString();
      return Promise.all(WINDOWS.map((w) => resellerRevenueApi.totals(tenantId, { from: w.from(now, zone).toISOString(), to })));
    },
    [tenantId, zone],
  );
  const show = (total: string | null, currency: string) => (total === null ? "—" : formatMoney(total, currency, { lang, t }));
  return (
    <WidgetBody source={source}>
      {(answers) => (
        <>
          {/* By the card's own width, not the screen's (a narrow grid column on a
              desktop is the same problem): a row per window until there is room
              for three columns side by side. */}
          <div className="@container">
            <dl className="grid grid-cols-1 gap-2 @md:grid-cols-3 @md:gap-3">
              {answers.map((a, i) => (
                <div
                  key={WINDOWS[i].key}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-2xl bg-bg-inner p-3 @md:block"
                >
                  <dt className="text-xs text-text-secondary">{t("common", WINDOWS[i].key)}</dt>
                  {a.fromResellers ? (
                    <dd className="flex gap-4 text-end @md:block @md:text-start">
                      <Line label={t("common", D.revenue.fromUsers)} amount={show(a.sales.total, a.currencyCode)} />
                      <Line label={t("common", D.revenue.fromResellers)} amount={show(a.fromResellers.charged.total, a.currencyCode)} />
                    </dd>
                  ) : (
                    <dd className="min-w-0 text-end @md:mt-1 @md:text-start">
                      <span className="inline-block whitespace-nowrap text-lg font-black tabular-nums text-text-primary" dir="ltr">
                        {show(a.sales.total, a.currencyCode)}
                      </span>
                      <span className="block text-2xs text-text-secondary">{t("common", D.revenue.sales, { count: a.sales.count })}</span>
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </div>
          {canAnalyse && (
            <>
              {/* Its own row, the card's full width, label over the line: beside the label and the link,
                  the full-width sparkline was squeezed and the label wrapped into a corner. */}
              {trend && (
                <div className="mt-3 rounded-2xl bg-bg-inner p-3" role="img" aria-label={t("common", D.revenue.trend)}>
                  <span className="block text-2xs text-text-secondary" aria-hidden>
                    {t("common", D.revenue.trend)}
                  </span>
                  <Sparkline values={trend} />
                </div>
              )}
              <FooterLink href={PANEL_ANALYTICS}>{t("common", D.revenue.seeAnalytics)}</FooterLink>
            </>
          )}
        </>
      )}
    </WidgetBody>
  );
}
