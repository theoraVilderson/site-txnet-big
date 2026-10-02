"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { aiAdminApi, type MeterForecast, type WalletForecast } from "@/lib/ai-api";
import { catalogApi } from "@/lib/catalog-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { flattenTexts, meterName } from "../../catalog/_lib/catalog-form";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { formatBytes } from "../../services/_lib/service-configs";
import { K, card } from "./ai-ui";

/** The one meter counted in bytes today; every other is a count of its own unit. */
const BYTE_METERS: readonly string[] = ["vpn.traffic"];

/**
 * The tenant's usage forecast (F-1525-a's routes): each meter's last 7 days
 * and next 30 at that pace, named from the catalog texts, and the billing
 * wallet's run-out with the top-up that holds 30 days. The platform owner also
 * sees every tenant summed, and how many tenants that covers. A forecast
 * only: nothing here charges or changes anything (§24.3).
 */
export function UsageForecastView() {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { me } = usePanelSession();
  const owner = me?.tenant?.type === "platform_owner";
  const [own, setOwn] = useState<{ meters: MeterForecast[]; wallet: WalletForecast | null } | null>(null);
  const [capacity, setCapacity] = useState<{ meters: MeterForecast[]; tenantsMeasured: number; tenants: number } | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    aiAdminApi
      .usageForecast()
      .then((r) => alive && setOwn(r))
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    if (owner) {
      aiAdminApi
        .capacity()
        .then((r) => alive && setCapacity(r))
        .catch((e: unknown) => alive && setError(errorMessage(e)));
    }
    catalogApi
      .texts(lang)
      .then(flattenTexts)
      .catch(() => ({}))
      .then((flat) => alive && setTexts(flat));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, owner]);

  const amount = (meterKey: string, units: string) => (BYTE_METERS.includes(meterKey) ? (formatBytes(units, lang) ?? units) : units);
  const money = (value: string, currencyCode: string) => formatMoney(value, currencyCode, { lang, t });
  const meters = (list: MeterForecast[]) =>
    list.length === 0 ? (
      <p className="text-sm text-text-secondary">{t("common", K.usage.empty)}</p>
    ) : (
      <ul className="flex flex-col gap-3">
        {list.map((m) => (
          <li key={m.meterKey} className={`${card} flex flex-col gap-1`}>
            <span className="text-sm font-bold text-text-primary">{meterName(texts, m.meterKey)}</span>
            <span className="text-sm text-text-primary">{t("common", K.usage.next30d, { amount: amount(m.meterKey, m.next30d) })}</span>
            <span className="text-xs text-text-secondary">
              {t("common", K.usage.last7d, { amount: amount(m.meterKey, m.last7d) })} · {t("common", K.usage.perDay, { amount: amount(m.meterKey, m.perDay) })}
            </span>
          </li>
        ))}
      </ul>
    );

  return (
    <section className="flex flex-col gap-4">
      <p className="text-xs text-text-secondary">{t("common", K.usage.intro)}</p>
      {error && <p role="alert" className="text-xs font-medium text-error">{error}</p>}
      {own === null ? (
        !error && <p className="text-sm text-text-secondary">{t("common", K.loading)}</p>
      ) : (
        <>
          {meters(own.meters)}
          {own.wallet && (
            <div className={`${card} flex flex-col gap-1`}>
              <span className="text-sm font-bold text-text-primary">{t("common", K.usage.walletTitle)}</span>
              <span className="text-sm text-text-primary">{t("common", K.usage.walletRunsOut, { date: formatInstant(own.wallet.runsOutAt, lang, { withTime: false }) ?? "" })}</span>
              <span className="text-xs text-text-secondary">{t("common", K.usage.walletRate, { amount: money(own.wallet.perDay, own.wallet.currencyCode) })}</span>
              <span className="text-sm text-text-primary">
                {Number(own.wallet.topUp) > 0 ? t("common", K.usage.topUp, { amount: money(own.wallet.topUp, own.wallet.currencyCode) }) : t("common", K.usage.topUpNone)}
              </span>
            </div>
          )}
        </>
      )}
      {owner && capacity && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-bold text-text-primary">{t("common", K.usage.capacityTitle)}</h2>
          <p className="text-xs text-text-secondary">{t("common", K.usage.covers, { measured: capacity.tenantsMeasured, total: capacity.tenants })}</p>
          {meters(capacity.meters)}
        </div>
      )}
    </section>
  );
}
