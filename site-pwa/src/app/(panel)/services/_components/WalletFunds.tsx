"use client";

import { AlertCircle, Lock, Wallet } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { formatMoney, isNonZero } from "../../_lib/money";

const W = FrontendI18nKeys.common.myServices.wallet;

/**
 * The wallet above the services it pays for (F-118-j): what can be spent, and
 * what is held for services in use — a VPN reserve, a meter's hold. Both are
 * `useWalletBalance`'s strings from billing; nothing here subtracts. Held
 * money says nothing when there is none, and a failed read is its own line,
 * never a zero.
 */
export function WalletFunds({
  available,
  held,
  currencyCode,
  failed,
}: {
  available: string | null;
  held: string | null;
  currencyCode: string | null;
  failed: boolean;
}) {
  const { t, lang } = useLocale();
  const money = (v: string, currency: string) => formatMoney(v, currency, { lang, t });

  if (available === null || currencyCode === null) {
    if (!failed) return null;
    return (
      <section aria-label={t("common", W.title)}>
        <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
          <AlertCircle size={14} className="shrink-0" aria-hidden />
          {t("common", W.unavailable)}
        </p>
      </section>
    );
  }

  return (
    <section aria-label={t("common", W.title)} className="rounded-2xl border border-card-border bg-card-bg p-3">
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Wallet size={16} className="shrink-0 text-primary" aria-hidden />
          <dt className="text-xs text-text-secondary">{t("common", W.available)}</dt>
          <dd className="font-mono text-sm font-bold text-text-primary">{money(available, currencyCode)}</dd>
        </div>
        {isNonZero(held) && (
          <div className="flex items-center gap-2">
            <Lock size={16} className="shrink-0 text-text-secondary" aria-hidden />
            <dt className="text-xs text-text-secondary">{t("common", W.held)}</dt>
            <dd className="font-mono text-sm font-bold text-text-primary">{money(held, currencyCode)}</dd>
          </div>
        )}
      </dl>
      {isNonZero(held) && <p className="mt-2 text-xs leading-5 text-text-secondary">{t("common", W.hint)}</p>}
    </section>
  );
}
