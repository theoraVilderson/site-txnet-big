"use client";

import { CreditCard, FlaskConical, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { DepositGateway } from "@/lib/billing-api";
import { Skeleton } from "../../../_components/kit/Skeleton";
import { formatMoney } from "../../../_lib/money";

const D = FrontendI18nKeys.common.deposit.gateway;

interface GatewaySelectorProps {
  gateways: DepositGateway[];
  /** The pair identifies a row: an id alone can belong to either table (D-25). */
  selected: DepositGateway | null;
  onSelect: (gateway: DepositGateway) => void;
  isLoading: boolean;
  /** The list did not load. Translated where there was server text, else the panel's own line. */
  error: string | null;
  onRetry: () => void;
}

/** `source:id` — the only thing that identifies a gateway across the two tables. */
export const gatewayKey = (g: DepositGateway) => `${g.source}:${g.id}`;

/**
 * The gateway picker (F-093-e).
 *
 * **Every gateway in this list is usable.** `GET /deposit/gateways` leaves out
 * anything without a driver, without a verified config or without a merchant
 * id in the vault (`billing/contract.deposit.md`), so there is no disabled
 * state to render and no "why can't I pick this" to explain. Legacy filtered a
 * hard-coded `GATEWAYS` array against what the server sent and rendered the
 * intersection — a gateway the tenant had just added showed up nowhere until
 * the app was rebuilt.
 *
 * The logo is the first letter of the display name. Legacy carried a colour and
 * a glyph per provider in a constant; a provider added server-side would have
 * had neither.
 */
export function GatewaySelector({
  gateways,
  selected,
  onSelect,
  isLoading,
  error,
  onRetry,
}: GatewaySelectorProps) {
  const { lang, t } = useLocale();
  const money = (value: string, currency: string) => formatMoney(value, currency, { lang, t });

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-text-primary">
        <CreditCard size={16} className="text-primary" aria-hidden />
        {t("common", D.label)}
      </h2>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label={t("common", D.loading)}>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-xs font-bold text-error">
            {error}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="flex items-center gap-1.5 rounded-xl border border-card-border px-3 py-1.5 text-xs font-bold text-text-secondary hover:text-text-primary"
          >
            <RotateCw size={12} aria-hidden />
            {t("common", D.retry)}
          </button>
        </div>
      ) : gateways.length === 0 ? (
        <p className="text-xs font-bold text-text-secondary">{t("common", D.empty)}</p>
      ) : (
        <div role="radiogroup" aria-label={t("common", D.label)} className="grid gap-3 sm:grid-cols-2">
          {gateways.map((gateway) => {
            const isSelected = selected !== null && gatewayKey(selected) === gatewayKey(gateway);
            return (
              <button
                key={gatewayKey(gateway)}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => onSelect(gateway)}
                className={`flex items-center gap-3 rounded-2xl border p-3 text-start transition-colors ${
                  isSelected
                    ? "border-primary bg-leaf-bg"
                    : "border-card-border bg-bg-inner hover:border-text-secondary"
                }`}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-white">
                  {gateway.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-bold text-text-primary">{gateway.displayName}</span>
                    {gateway.testing && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-primary px-1.5 py-0.5 text-[10px] font-bold text-primary">
                        <FlaskConical size={10} aria-hidden />
                        {t("common", D.testing)}
                      </span>
                    )}
                  </span>
                  <span dir="ltr" className="block truncate text-[11px] text-text-secondary">
                    {gateway.minAmount && gateway.maxAmount
                      ? t("common", D.range, { min: money(gateway.minAmount, gateway.currencyCode), max: money(gateway.maxAmount, gateway.currencyCode) })
                      : gateway.minAmount
                        ? t("common", D.rangeFrom, { min: money(gateway.minAmount, gateway.currencyCode) })
                        : gateway.maxAmount
                          ? t("common", D.rangeUpTo, { max: money(gateway.maxAmount, gateway.currencyCode) })
                          : t("common", D.rangeAny)}
                  </span>
                </span>
              </button>
            );
          })}
          {selected?.testing && (
            <p className="flex items-start gap-2 rounded-xl border border-dashed border-primary bg-leaf-bg p-3 text-[11px] leading-5 text-text-primary sm:col-span-2">
              <FlaskConical size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden />
              {t("common", D.testingHint)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
