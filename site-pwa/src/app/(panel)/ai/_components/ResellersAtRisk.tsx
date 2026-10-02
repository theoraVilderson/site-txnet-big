"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { aiAdminApi, type AiReason, type ResellerForecastItem, type ResellerForecastKind } from "@/lib/ai-api";
import { RESELLER_LIMIT_KEYS } from "@/lib/reseller-limits";
import { panelResellerPath } from "@/lib/routes";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { K, card } from "./ai-ui";

const LIMIT_NAMES = FrontendI18nKeys.common.resellers.limits.keys;
const PERIODS = ["day", "week", "month"] as const;

/** The reseller codes this tab words; `churn_base` is the arithmetic's start and says nothing. */
const WORDED = ["quota_rate", "quota_full", "wallet_short", "renewal_unpaid", "sales_fell", "sales_grew", "downgrade_scheduled", "wholesale_rate"] as const;
type Worded = (typeof WORDED)[number];
const isWorded = (code: string): code is Worded => (WORDED as readonly string[]).includes(code);

/**
 * The platform owner's resellers at risk (F-038-o2's list), each linked to its
 * reseller page, with the engine's reasons in words. A quota is named as the
 * limits page names it; a product's sales generically — ai sends the product
 * by id only. A code with no words is left out, never shown raw.
 */
export function ResellersAtRisk() {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [kind, setKind] = useState<ResellerForecastKind>("quota_exhaustion");
  const [items, setItems] = useState<ResellerForecastItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    aiAdminApi
      .resellers(kind)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const more = async () => {
    try {
      const page = await aiAdminApi.resellers(kind, cursor);
      setItems((now) => [...(now ?? []), ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const date = (iso: string | null) => formatInstant(iso, lang, { withTime: false }) ?? "";
  const quotaName = (meter: unknown) =>
    typeof meter === "string" && (RESELLER_LIMIT_KEYS as readonly string[]).includes(meter)
      ? t("common", LIMIT_NAMES[meter as (typeof RESELLER_LIMIT_KEYS)[number]].name)
      : t("common", K.resellers.productSales);
  const periodName = (p: unknown) => ((PERIODS as readonly unknown[]).includes(p) ? t("common", K.resellers.period[p as (typeof PERIODS)[number]]) : "");
  const words = (r: AiReason): string | null => {
    if (!isWorded(r.code)) return null;
    switch (r.code) {
      case "quota_rate":
        return t("common", K.reasons.quota_rate, { quota: quotaName(r["meter"]), used: Number(r["used"] ?? 0), included: Number(r["included"] ?? 0), period: periodName(r["period"]), perDay: Number(r["perDay"] ?? 0) });
      case "quota_full":
        return t("common", K.reasons.quota_full, { quota: quotaName(r["meter"]), included: Number(r["included"] ?? 0), used: Number(r["used"] ?? 0), period: periodName(r["period"]) });
      case "wholesale_rate":
        return t("common", K.reasons.wholesale_rate, { amount: formatMoney(String(r["perDay"] ?? "0"), String(r["currencyCode"] ?? ""), { lang, t }) });
      case "wallet_short":
        return t("common", K.reasons.wallet_short, { balance: String(r["balance"] ?? ""), price: String(r["price"] ?? ""), currency: String(r["currencyCode"] ?? "") });
      default:
        return t("common", K.reasons[r.code]);
    }
  };
  const when = (item: ResellerForecastItem) =>
    kind === "wallet_need"
      ? `${t("common", K.resellers.walletRunsOut, { date: date(item.predictedAt) })} · ${t("common", K.resellers.topUp, { amount: formatMoney(item.value ?? "0", item.currencyCode ?? "", { lang, t }) })}`
      : kind === "quota_exhaustion"
      ? Number(item.value ?? 0) === 0
        ? t("common", K.resellers.fullNow)
        : t("common", K.resellers.runsOutOn, { date: date(item.predictedAt) })
      : `${t("common", K.resellers.churnChance, { percent: Math.round(Number(item.value ?? 0) * 100) })} · ${t("common", K.resellers.renewsOn, { date: date(item.predictedAt) })}`;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex gap-2">
        {(["quota_exhaustion", "churn_risk", "wallet_need"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => {
              if (k === kind) return;
              setItems(null);
              setError(null);
              setKind(k);
            }}
            className={`rounded-xl px-3 py-1.5 text-xs font-bold ${kind === k ? "bg-primary text-white" : "border border-card-border text-text-secondary"}`}
          >
            {t("common", k === "quota_exhaustion" ? K.resellers.runOut : k === "churn_risk" ? K.resellers.churn : K.resellers.wallet)}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-xs font-medium text-error">{error}</p>}
      {items === null ? (
        !error && <p className="text-sm text-text-secondary">{t("common", K.loading)}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.resellers.empty)}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.tenantId} className={`${card} flex flex-col gap-2`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {item.slug ? (
                  <Link href={panelResellerPath(item.tenantId)} className="text-sm font-bold text-primary underline" dir="ltr">
                    {item.slug}
                  </Link>
                ) : (
                  <span className="text-sm font-bold" dir="ltr">{item.tenantId}</span>
                )}
                <span className="text-xs text-text-secondary">{when(item)}</span>
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {item.reasons.map((r, i) => {
                  const said = words(r);
                  return said ? (
                    <li key={i} className="rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-xs text-text-primary">{said}</li>
                  ) : null;
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {cursor && items && (
        <div>
          <button type="button" className="text-xs font-bold text-text-secondary underline" onClick={() => void more()}>{t("common", K.resellers.more)}</button>
        </div>
      )}
    </section>
  );
}
