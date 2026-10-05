"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { resellerRevenueApi } from "@/lib/billing-api";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatMoney } from "../../../_lib/money";
import { startOfDayIn } from "../../../_lib/widgets";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;
const DAY_MS = 86_400_000;

const WINDOWS = [
  { key: D.revenue.today, from: (now: Date, zone: string | null) => startOfDayIn(now, zone) },
  { key: D.revenue.week, from: (now: Date) => new Date(now.getTime() - 7 * DAY_MS) },
  { key: D.revenue.month, from: (now: Date) => new Date(now.getTime() - 30 * DAY_MS) },
] as const;

/** One labelled figure of the platform's two (UX-1-r3): users, then resellers. */
function Line({ label, amount }: { label: string; amount: string }) {
  return (
    <dd className="mt-1 flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-text-secondary">{label}</span>
      <span className="truncate text-sm font-black tabular-nums text-text-primary" dir="ltr">
        {amount}
      </span>
    </dd>
  );
}

/**
 * Revenue (UX-1-r, D5): what the caller's tenant sold today (from midnight in
 * their resolved zone), over 7 and over 30 days — F-311-b's totals, one call
 * per window, each in that tenant's operating currency. A total billing could
 * not convert reads as a dash, never as a sum of two currencies. On the
 * platform's own tenant its users' sales and what it charged its resellers are
 * two lines, never added into one (UX-1-r3).
 */
export default function RevenueWidget() {
  const { t, lang } = useLocale();
  const { me, timeZone } = usePanelSession();
  const tenantId = me?.tenant.id ?? null;
  const zone = timeZone?.zone ?? null;
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
        <dl className="grid grid-cols-3 gap-3">
          {answers.map((a, i) => (
            <div key={WINDOWS[i].key} className="min-w-0 rounded-2xl bg-bg-inner p-3">
              <dt className="text-xs text-text-secondary">{t("common", WINDOWS[i].key)}</dt>
              {a.fromResellers ? (
                <>
                  <Line label={t("common", D.revenue.fromUsers)} amount={show(a.sales.total, a.currencyCode)} />
                  <Line label={t("common", D.revenue.fromResellers)} amount={show(a.fromResellers.charged.total, a.currencyCode)} />
                </>
              ) : (
                <>
                  <dd className="mt-1 truncate text-lg font-black tabular-nums text-text-primary" dir="ltr">
                    {show(a.sales.total, a.currencyCode)}
                  </dd>
                  <dd className="text-[11px] text-text-secondary">{t("common", D.revenue.sales, { count: a.sales.count })}</dd>
                </>
              )}
            </div>
          ))}
        </dl>
      )}
    </WidgetBody>
  );
}
