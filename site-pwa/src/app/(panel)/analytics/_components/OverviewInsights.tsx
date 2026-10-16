"use client";

import Link from "next/link";
import {
  CalendarDays,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Card, CardHeader } from "../../_components/kit";
import { type InsightIcon, type InsightLine } from "../_lib/insights";

const ICONS: Record<InsightIcon, LucideIcon> = {
  up: TrendingUp,
  down: TrendingDown,
  day: CalendarDays,
};

/**
 * The Overview's "what changed" strip (F-1001-k, item 3): up to three lines,
 * each with an icon and a link to where it is explained. The icon is neutral
 * ink — a fall in refunds is good news, so no line wears a status colour on
 * direction alone (chart rule 4). Nothing to say draws nothing.
 */
export function OverviewInsights({ lines }: { lines: readonly InsightLine[] }) {
  const { t } = useLocale();
  if (lines.length === 0) return null;
  return (
    <Card
      padding="sm"
      role="region"
      aria-label={t("common", FrontendI18nKeys.common.analytics.insights.title)}
    >
      <CardHeader
        title={t("common", FrontendI18nKeys.common.analytics.insights.title)}
        className="mb-2"
      />
      <ul className="flex flex-col gap-2">
        {lines.map((line) => {
          const Icon = ICONS[line.icon];
          return (
            <li
              key={line.id}
              className="flex items-start gap-2 text-sm text-text-primary"
            >
              <Icon
                size={16}
                aria-hidden
                className="mt-0.5 shrink-0 text-text-secondary"
              />
              <span className="min-w-0 flex-1">{line.text}</span>
              {line.link && (
                <Link
                  href={line.link.href}
                  scroll={false}
                  className="shrink-0 text-xs font-bold text-primary hover:underline"
                >
                  {line.link.label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
