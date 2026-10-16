"use client";

import Link from "next/link";
import { AlertTriangle, CalendarClock, CheckCircle2, TrendingDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsCapacity, CapacityPanel } from "@/lib/billing/analytics";
import { formatMoney } from "../../_lib/money";
import { formatList } from "../../_lib/digits";
import { Alert, Badge, type Tone } from "../../_components/kit";
import { ChartCard, Meter, useChartFormat } from "../../_components/kit/charts";
import { formatBytes } from "../../services/_lib/service-configs";
import { type Urgency, ratioOf, urgencyOf } from "../_lib/capacity";

const K = FrontendI18nKeys.common.analytics;
const C = K.capacity;
/** A panel's price is in dollars whatever the tenant sells in (network `contract.panel-cost.md` rule 5). */
const PANEL_CURRENCY = "USD";

/** Each urgency's badge: a word and an icon beside the colour, never colour alone (chart rule 4). */
const URGENCY: Record<Urgency, { tone: Tone; icon: typeof AlertTriangle }> = {
  full: { tone: "error", icon: AlertTriangle },
  soon: { tone: "warning", icon: CalendarClock },
  later: { tone: "info", icon: CalendarClock },
  none: { tone: "success", icon: CheckCircle2 },
};

export interface CapacityTabProps {
  /** Null on the first load: the card draws its skeleton. */
  capacity: AnalyticsCapacity | null;
  currency: string;
  formatDay: (day: string) => string;
  /** Where a panel's price and traffic are set — the platform's own view only; a reseller cannot price a panel yet. */
  systemsHref: string | null;
  stale: boolean;
}

/**
 * The Capacity tab (F-1005-b, panel-web `contract.analytics-tabs.md`
 * "Capacity"; billing `capacity`, F-1005-a): each panel the tenant owns this
 * UTC month — its traffic against the month's allowance, its users against the
 * cap, when it fills (the sooner of the two) and the month's cost and margin.
 * The window and comparison do not apply: a forecast is made today.
 */
export function CapacityTab({ capacity, currency, formatDay, systemsHref, stale }: CapacityTabProps) {
  const { t, lang } = useLocale();
  const fmt = useChartFormat();
  const size = (bytes: string | null) => (bytes === null ? "—" : (formatBytes(bytes, lang) ?? bytes));
  const money = (amount: string | undefined) => (amount === undefined ? "—" : formatMoney(amount, currency, { lang, t }));
  const usd = (amount: string | null) => (amount === null ? "—" : formatMoney(amount, PANEL_CURRENCY, { lang, t }));
  const panels = capacity?.panels ?? [];
  const unpriced = panels.filter((p) => p.monthlyCostUsd === null);

  const when = (p: CapacityPanel) => {
    const urgency = urgencyOf(p);
    if (urgency === "none" || p.fullOn === null) return t("common", C.full.none);
    if (urgency === "full") return t("common", C.full.now);
    return t("common", C.full.on, { day: formatDay(p.fullOn), days: fmt.full(p.daysUntilFull ?? 0) });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-5 text-text-secondary">{capacity ? t("common", C.asOf, { day: formatDay(capacity.today) }) : t("common", C.intro)}</p>

      {unpriced.length > 0 && (
        <Alert
          tone="info"
          title={t("common", C.noPrice.title)}
          action={
            systemsHref && (
              <Link href={systemsHref} className="text-sm font-semibold text-primary hover:underline">
                {t("common", C.noPrice.action)}
              </Link>
            )
          }
        >
          {t("common", C.noPrice.body, { panels: formatList(unpriced.map((p) => p.name), lang) })}
        </Alert>
      )}

      <ChartCard<CapacityPanel>
        title={t("common", C.title)}
        subtitle={t("common", C.subtitle)}
        state={!capacity ? "loading" : panels.length === 0 ? "empty" : "ready"}
        stale={stale}
        table={{
          columns: [
            { id: "name", header: t("common", C.panel), cell: (p) => p.name },
            { id: "used", header: t("common", C.traffic.used), cell: (p) => size(p.usedBytes), dir: "ltr" },
            { id: "projected", header: t("common", C.traffic.projected), cell: (p) => size(p.projectedBytes), dir: "ltr" },
            { id: "allowance", header: t("common", C.traffic.allowance), cell: (p) => size(p.allowanceBytes), dir: "ltr" },
            { id: "users", header: t("common", C.users.title), cell: (p) => (p.clients === null ? "—" : fmt.full(p.clients)), dir: "ltr" },
            { id: "cap", header: t("common", C.users.cap), cell: (p) => (p.maxClients === null ? "—" : fmt.full(p.maxClients)), dir: "ltr" },
            { id: "full", header: t("common", C.full.title), cell: when },
            { id: "cost", header: t("common", C.money.cost), cell: (p) => usd(p.projectedCostUsd), dir: "ltr" },
            { id: "margin", header: t("common", C.money.margin), cell: (p) => (p.margin ? money(p.margin[currency]) : t("common", C.money.noCost)), dir: "ltr" },
          ],
          rows: panels,
          rowKey: (p) => p.panelId,
        }}
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          {panels.map((p) => {
            const { tone, icon: Icon } = URGENCY[urgencyOf(p)];
            return (
              <li key={p.panelId} className="flex flex-col gap-3 rounded-2xl bg-bg-inner p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-text-primary">{p.name}</span>
                  <Badge tone={tone} icon={<Icon size={12} aria-hidden />}>
                    {when(p)}
                  </Badge>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-text-secondary">{t("common", C.traffic.title)}</span>
                  <Meter value={ratioOf(p.projectedBytes, p.allowanceBytes)} label={t("common", C.traffic.title)} />
                  <span className="text-xs text-text-secondary">
                    {p.allowanceBytes === null
                      ? t("common", C.traffic.noAllowance, { used: size(p.usedBytes), projected: size(p.projectedBytes) })
                      : t("common", C.traffic.ofAllowance, { used: size(p.usedBytes), projected: size(p.projectedBytes), allowance: size(p.allowanceBytes) })}
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-text-secondary">{t("common", C.users.title)}</span>
                  <Meter value={ratioOf(p.clients, p.maxClients)} label={t("common", C.users.title)} />
                  <span className="text-xs text-text-secondary">
                    {p.maxClients === null
                      ? t("common", C.users.noCap, { clients: fmt.full(p.clients ?? 0) })
                      : t("common", C.users.ofCap, { clients: fmt.full(p.clients ?? 0), cap: fmt.full(p.maxClients) })}
                    {p.clientsPerDay !== null && p.clientsPerDay !== 0 && ` · ${t("common", C.users.perDay, { count: fmt.full(p.clientsPerDay) })}`}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-card-border pt-2 text-xs">
                  {p.margin ? (
                    <>
                      <span className="text-text-secondary">{t("common", C.money.costOf, { amount: usd(p.projectedCostUsd) })}</span>
                      <span className="inline-flex items-center gap-2 font-semibold text-text-primary">
                        {t("common", C.money.marginOf, { amount: money(p.margin[currency]) })}
                        {p.loss && (
                          <Badge tone="error" icon={<TrendingDown size={12} aria-hidden />}>
                            {t("common", K.profit.loss)}
                          </Badge>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="text-text-secondary">{t("common", C.money.noCost)}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </ChartCard>
    </div>
  );
}
