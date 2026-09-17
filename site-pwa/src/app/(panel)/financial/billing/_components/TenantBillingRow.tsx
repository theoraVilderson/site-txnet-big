"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { TenantWalletRow } from "@/lib/billing-api";
import { BASE_CURRENCY, formatMoney } from "../../../_lib/money";
import { formatInstant } from "../../../_lib/datetime";
import { DIRECTION_TONES } from "../../_lib/tones";
import { Badge } from "../../_components/Badge";

const B = FrontendI18nKeys.common.tenantBilling;

/** A reason type's label key; a value the API adds later renders as itself. */
function reasonLabelKey(reasonType: string): string | null {
  return (B.reason as Record<string, string | undefined>)[reasonType] ?? null;
}

/**
 * One movement of a reseller's billing wallet (F-019-d). `balanceAfter` is
 * printed as the ledger wrote it — nothing here adds an amount to a balance.
 */
export function TenantBillingRow({ row }: { row: TenantWalletRow }) {
  const { lang, t } = useLocale();
  const tone = DIRECTION_TONES[row.direction];
  const Icon = tone.icon;
  const credit = row.direction === "credit";
  const reasonKey = reasonLabelKey(row.reasonType);
  const money = (amount: string) => formatMoney(amount, BASE_CURRENCY, { lang, t });
  const when = formatInstant(row.createdAt, lang);

  return (
    <div className="grid grid-cols-12 items-center gap-3 border-b border-card-border px-4 py-4 last:border-b-0 md:px-6">
      <div
        className={`col-span-2 flex h-10 w-10 items-center justify-center rounded-2xl border md:col-span-1 ${tone.className}`}
      >
        <Icon size={18} aria-hidden />
      </div>

      <div className="col-span-10 min-w-0 md:col-span-4">
        <p className="truncate text-sm font-bold text-text-primary">
          {reasonKey ? t("common", reasonKey) : row.reasonType}
        </p>
        <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary" dir="ltr">
          {row.id}
        </p>
      </div>

      <div className="col-span-6 flex flex-col md:col-span-2 md:items-start">
        <span dir="ltr" className={`text-sm font-bold tracking-tight ${credit ? "text-primary" : "text-error"}`}>
          {credit ? "+" : "−"} {money(row.amount)}
        </span>
        <span className="md:hidden">
          <Badge icon={tone.icon} label={t("common", tone.labelKey)} className={tone.className} />
        </span>
      </div>

      <div className="col-span-6 flex flex-col items-end gap-1 md:col-span-2 md:items-center">
        {when && (
          <span dir="ltr" className="font-mono text-[11px] text-text-primary">
            {when}
          </span>
        )}
        <span className="hidden md:block">
          <Badge icon={tone.icon} label={t("common", tone.labelKey)} className={tone.className} />
        </span>
      </div>

      <div className="col-span-12 flex items-center justify-between md:col-span-3 md:flex-col md:items-end">
        <span className="text-[10px] text-text-secondary md:hidden">{t("common", B.columns.balanceAfter)}</span>
        <span dir="ltr" className="font-mono text-xs font-medium text-gold">
          {money(row.balanceAfter)}
        </span>
      </div>
    </div>
  );
}
