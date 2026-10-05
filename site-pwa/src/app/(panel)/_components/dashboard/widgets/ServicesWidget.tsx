"use client";

import Link from "next/link";
import { Globe, ShoppingCart } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { PANEL_MY_SERVICES, PANEL_SHOP, panelMyServicesSearchPath } from "@/lib/routes";
import { flattenTexts } from "../../../catalog/_lib/catalog-form";
import { serviceName } from "../../../services/_lib/my-services";
import { levelOf, runningOut, trafficBound } from "../../../services/_lib/pulse";
import { formatBytes } from "../../../services/_lib/service-configs";
import { usedShare } from "../../../services/_lib/usage";
import { EmptyState, StatusPill } from "../../kit";
import { FooterLink, WidgetList } from "../parts";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;
const S = D.services;

/** At most this many services on the card; the rest are a link away. */
export const SERVICES_SHOWN = 5;

const BAR = { ok: "bg-primary", low: "bg-gold", critical: "bg-error" } as const;

/** One service's traffic in a line: a bar against its bound, else what it used. */
function Meter({ row }: { row: GrantRow }) {
  const { t, lang } = useLocale();
  const used = formatBytes(row.consumedBytes, lang) ?? row.consumedBytes;
  const bound = trafficBound(row);
  const share = bound === null ? null : usedShare(row.consumedBytes, bound);
  if (bound === null || share === null) {
    return (
      <p className="text-xs text-text-secondary">
        {t("common", row.trafficUnlimited ? S.usedUnlimited : S.usedOnly, { used })}
      </p>
    );
  }
  const level = levelOf(1 - share);
  return (
    <div className="space-y-1">
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        aria-label={t("common", S.used, { used, total: formatBytes(bound, lang) ?? bound })}
        className="h-1.5 overflow-hidden rounded-full bg-bg-inner"
      >
        <div className={`h-full rounded-full transition-[width] duration-500 ${BAR[level]}`} style={{ width: `${share * 100}%` }} />
      </div>
      <p className="text-xs text-text-secondary">{t("common", S.used, { used, total: formatBytes(bound, lang) ?? bound })}</p>
    </div>
  );
}

/**
 * My services (UX-1-q, D4): the active ones in the list's own order, each with
 * its traffic and a gold "running out" pill per U3, and a way to buy another.
 */
export default function ServicesWidget() {
  const { t, lang } = useLocale();
  const source = useWidgetSource(
    "services",
    async () => {
      const [page, texts] = await Promise.all([
        billingApi.grants(1, 20, "current"),
        catalogApi.texts(lang).then(flattenTexts).catch(() => ({}) as Record<string, string>),
      ]);
      return { rows: page.rows.filter((r) => r.status === "active"), texts };
    },
    [lang],
  );
  const buy = (
    <Link href={PANEL_SHOP} className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-bold text-on-accent hover:brightness-105">
      <ShoppingCart size={14} aria-hidden />
      {t("common", D.quick.buy)}
    </Link>
  );

  return (
    <WidgetBody
      source={source}
      isEmpty={(d) => d.rows.length === 0}
      empty={<EmptyState icon={Globe} title={t("common", S.empty)} action={buy} className="py-4" />}
    >
      {({ rows, texts }) => {
        const now = new Date();
        return (
          <div className="flex h-full flex-col">
            <WidgetList>
              {rows.slice(0, SERVICES_SHOWN).map((row) => {
                const name = row.label ?? serviceName(texts, row) ?? row.id.slice(0, 8);
                return (
                  <li key={row.id} className="space-y-2 py-3 first:pt-0">
                    <div className="flex items-center justify-between gap-2">
                      <Link href={panelMyServicesSearchPath(name)} className="truncate text-sm font-bold text-text-primary hover:text-primary">
                        {name}
                      </Link>
                      {runningOut(row, now) && <StatusPill tone="gold">{t("common", S.runningOut)}</StatusPill>}
                    </div>
                    <Meter row={row} />
                  </li>
                );
              })}
            </WidgetList>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
              <FooterLink href={PANEL_MY_SERVICES}>{t("common", S.seeAll)}</FooterLink>
              <div className="pt-4">{buy}</div>
            </div>
          </div>
        );
      }}
    </WidgetBody>
  );
}
