"use client";

import { ArrowDown, Wallet } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { formatMoney } from "../../../_lib/money";

const D = FrontendI18nKeys.common.deposit.wallet;

interface WalletPreviewProps {
  /** The balance billing last answered, or `null` while there is none to show. */
  balance: string | null;
  /** The quote's `credited` — what will land in the wallet — or `null` with no quote. */
  credited: string | null;
  /**
   * What each figure is in (F-116-h3): the wallet's, and the quote's — the
   * same one today, since a gateway in another currency is never offered, but
   * each figure names its own rather than assume it.
   */
  balanceCurrency: string | null;
  creditedCurrency: string | null;
}

/**
 * The wallet card (F-093-e): the balance now, and what this top-up adds.
 *
 * **It shows two figures and never their sum**, which is the one place this
 * port deliberately leaves legacy's screen behind. Legacy printed
 * `currentBalance + userChargeAmount` as "your balance after topping up", and
 * both halves of that were client arithmetic on money: the balance came from a
 * store components were free to adjust, and the charge was the browser's own
 * copy of the bill. `contract.shell.md` rule 1 is the correction — the panel
 * shows the balance `billing` answered and never adjusts a held figure — and a
 * projected total is that same sum with a softer label on it. The credit is
 * the quote's `credited`, which already carries the adjustment gap, so the two
 * figures side by side say everything the projection did and neither is a
 * guess.
 */
export function WalletPreview({ balance, credited, balanceCurrency, creditedCurrency }: WalletPreviewProps) {
  const { lang, t } = useLocale();
  const money = (value: string, currency: string) => formatMoney(value, currency, { lang, t });

  return (
    <div
      className="relative overflow-hidden rounded-3xl p-6 text-white shadow-xl"
      style={{ background: "var(--card-gradient)" }}
    >
      {/* Decorative, and inert to a screen reader: the figures below say it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -end-10 -top-10 size-40 rounded-full bg-white/10 blur-3xl"
      />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/60">
            {t("common", D.current)}
          </p>
          <p dir="ltr" className="mt-1 truncate text-2xl font-bold">
            {balance === null || balanceCurrency === null ? "—" : money(balance, balanceCurrency)}
          </p>
        </div>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/10">
          <Wallet size={18} aria-hidden />
        </span>
      </div>

      <div className="relative mt-6 border-t border-white/10 pt-4">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-white/50">
          <ArrowDown size={12} aria-hidden />
          {t("common", D.incoming)}
        </p>
        {credited === null || creditedCurrency === null ? (
          <p className="mt-1 text-sm font-bold text-white/60">{t("common", D.pending)}</p>
        ) : (
          <p dir="ltr" className="mt-1 truncate text-3xl font-bold">
            +{money(credited, creditedCurrency)}
          </p>
        )}
      </div>
    </div>
  );
}
