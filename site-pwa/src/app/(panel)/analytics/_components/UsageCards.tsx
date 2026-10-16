"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsUsageCard } from "@/lib/billing/analytics";
import { ChartCard, TrendChart } from "../../_components/kit/charts";

const K = FrontendI18nKeys.common.analytics;
const CARD_HEIGHT = 180;

/** A drawable number for a bucket; a hidden one stays a gap, never zero. */
export const usagePoints = (series: readonly (string | null)[]): (number | null)[] => series.map((v) => (v === null ? null : Number(v)));

export interface UsageCardsProps {
  usage: readonly AnalyticsUsageCard[];
  /** The bucket labels, as the page writes a date in its calendar. */
  x: readonly string[];
  meterName: (key: string) => string;
  formatOf: (key: string) => (n: number) => string;
  stale: boolean;
}

/**
 * One usage card per meter (F-1001-o, ADR-0148 (5)): its trend over the
 * window in its own unit — one axis, never two meters on one chart (rule 1).
 * A meter used only in the compared window still has its card, flat at zero,
 * so a usage that stopped is seen. No meter used: no card.
 */
export function UsageCards({ usage, x, meterName, formatOf, stale }: UsageCardsProps) {
  const { t } = useLocale();
  if (usage.length === 0) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {usage.map((card) => {
        const label = meterName(card.meterKey);
        const format = formatOf(card.meterKey);
        const values = usagePoints(card.series);
        const rows = x.map((day, i) => ({ x: day, value: values[i] ?? null }));
        return (
          <ChartCard<(typeof rows)[number]>
            key={card.meterKey}
            title={label}
            subtitle={t("common", K.usage.subtitle)}
            state="ready"
            stale={stale}
            height={CARD_HEIGHT}
            table={{
              columns: [
                { id: "x", header: t("common", K.table.date), cell: (r) => r.x },
                { id: "value", header: t("common", K.table.value), cell: (r) => (r.value === null ? "—" : format(r.value)), dir: "ltr" },
              ],
              rows,
              rowKey: (r) => r.x,
            }}
          >
            <TrendChart label={label} x={x} series={[{ id: card.meterKey, label, values }]} variant="area" height={CARD_HEIGHT} formatValue={format} formatTick={format} />
          </ChartCard>
        );
      })}
    </div>
  );
}
