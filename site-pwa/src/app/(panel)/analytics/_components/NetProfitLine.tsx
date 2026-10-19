"use client";

import Link from "next/link";
import { TrendingDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsMargin } from "@/lib/billing/analytics";
import { formatMoney } from "../../_lib/money";
import { Badge, Card, CardHeader } from "../../_components/kit";
import { StatTile } from "../../_components/kit/charts";
import { amountIn } from "../_lib/overview";

const P = FrontendI18nKeys.common.analytics.profit;

export interface NetProfitLineProps {
  totals: AnalyticsMargin["totals"];
  currency: string;
  /** Where the tenant's expenses are kept; null where this viewer has none to keep (the platform on a reseller). */
  expensesHref: string | null;
}

/**
 * Margin minus general expenses and the gateways' commission (F-1001-u,
 * F-1001-w; billing `margin` `totals.overhead`, `totals.gatewayCommission`,
 * `totals.netProfit`): what is left once the costs no sale carries are paid,
 * each part beside the result so the figures add up, a loss said in a word
 * beside its colour. Billing answers none
 * under a product, panel or kind filter — an expense is no product's — and
 * the line says so instead of drawing a margin as if it were net.
 */
export function NetProfitLine({ totals, currency, expensesHref }: NetProfitLineProps) {
  const { t, lang } = useLocale();
  if (!expensesHref) return null;
  const { overhead, gatewayCommission, netProfit } = totals;
  // Absent: an answer cached before the figure existed — nothing to say about it.
  if (overhead === undefined || netProfit === undefined) return null;
  if (overhead === null || netProfit === null) return <p className="text-xs text-text-secondary">{t("common", P.netProfit.filtered)}</p>;
  const money = (n: number) => formatMoney(n, currency, { lang, t });
  const net = amountIn(netProfit.value, currency) ?? 0;
  const title = t("common", P.netProfit.title);

  return (
    <section aria-label={title}>
      <Card padding="sm">
        <CardHeader
          title={title}
          subtitle={t("common", P.netProfit.subtitle)}
          className="mb-3"
          actions={
            <Link href={expensesHref} className="text-sm font-semibold text-primary hover:underline">
              {t("common", P.netProfit.action)}
            </Link>
          }
        />
        <div className={`grid grid-cols-2 gap-3 ${gatewayCommission ? "sm:grid-cols-3" : ""}`}>
          <StatTile label={t("common", P.kpis.overhead)} value={amountIn(overhead.value, currency) ?? 0} format={money} delta={overhead.delta[currency] ?? null} downIsGood />
          {/* Absent in an answer cached before F-1001-v: the expenses alone, as before. */}
          {gatewayCommission && (
            <StatTile label={t("common", P.kpis.gatewayCommission)} value={amountIn(gatewayCommission.value, currency) ?? 0} format={money} delta={gatewayCommission.delta[currency] ?? null} downIsGood />
          )}
          <div className="flex flex-col gap-1">
            <StatTile label={t("common", P.kpis.netProfit)} value={net} format={money} delta={netProfit.delta[currency] ?? null} />
            {net < 0 && (
              <Badge tone="error" icon={<TrendingDown size={12} aria-hidden />}>
                {t("common", P.loss)}
              </Badge>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
