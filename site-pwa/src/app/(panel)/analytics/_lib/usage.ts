import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AnalyticsNames, MeterUnit } from "@/lib/billing/analytics";
import type { ChartFormat } from "../../_components/kit/charts";
import { numberLocale } from "../../_lib/digits";
import { formatBytes } from "../../services/_lib/service-configs";

/**
 * Usage per meter on the Overview (F-1001-o, ADR-0148 (5)): each meter is
 * written in its own unit and named by its catalog text, so a meter billing
 * adds tomorrow draws itself. Only a new *unit* needs a line here — the
 * exhaustive table below fails to compile without it.
 */

const K = FrontendI18nKeys.common.analytics;
const SECONDS_PER_HOUR = 3600;

export interface UsageWords {
  lang: string;
  t: (ns: "common", key: string, vars?: Record<string, string>) => string;
  fmt: ChartFormat;
}

/** How a figure in each unit is written. */
export const UNIT_FORMATS: Record<MeterUnit, (w: UsageWords) => (n: number) => string> = {
  bytes: ({ lang }) => (n) => formatBytes(String(Math.round(n)), lang) ?? "",
  count: ({ fmt }) => fmt.full,
  // Hours read better than a seconds count; `Intl` writes the unit word in the language.
  seconds: ({ lang }) => {
    const hours = new Intl.NumberFormat(numberLocale(lang), { style: "unit", unit: "hour", maximumFractionDigits: 1 });
    return (n) => hours.format(n / SECONDS_PER_HOUR);
  },
  tokens: ({ t, fmt }) => (n) => t("common", K.units.tokens, { count: fmt.full(n) }),
};

export const usageFormat = (unit: MeterUnit, w: UsageWords): ((n: number) => string) => UNIT_FORMATS[unit](w);

/** A meter's key -> its words in the reader's language; one without a text yet reads as "usage", never as its key. */
export function meterNamer(names: AnalyticsNames, texts: Record<string, string>, t: UsageWords["t"]): (key: string) => string {
  const keys = new Map(names.meters.map((m) => [m.key, m.nameKey]));
  return (key) => {
    const nameKey = keys.get(key);
    return (nameKey ? texts[nameKey] : undefined) ?? t("common", K.usage.unnamed);
  };
}
