"use client";

import { useState } from "react";
import { AlertCircle, ChevronDown, Loader2, Receipt, ShieldCheck, Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { DepositQuote } from "@/lib/billing-api";
import { BASE_CURRENCY, formatMoney } from "../../../_lib/money";
import { fromMinor } from "../_lib/deposit-amount";

const D = FrontendI18nKeys.common.deposit.summary;

interface PaymentSummaryProps {
  /** The bill for what is on screen, or `null` when there is none to show. */
  quote: DepositQuote | null;
  isQuoting: boolean;
  /** A quote or a start that failed, already in the user's language. */
  error: string | null;
  /** The start call is in flight, or the browser is on its way to the gateway. */
  isStarting: boolean;
  onPay: () => void;
  /** The mobile footer variant: the same numbers, collapsed behind a disclosure. */
  compact?: boolean;
}

/**
 * The bill (F-093-e), sticky beside the form on desktop and a footer on mobile.
 *
 * **Every line is a field of the quote.** Not one of them is added up here —
 * not the payable, not the total discount, not what the gateway will charge
 * (F-0612, `billing/contract.deposit.md`). Legacy's version took an amount, a
 * tax rate, a fee and a coupon array and did the arithmetic in the render, and
 * that render was the second implementation of a calculation the server also
 * had. There is no tax row here for the same reason there is no tax field:
 * tax is inside the figures `priceAtGateway` answers, and a row this app
 * computed would be one more number nothing vouches for.
 *
 * The mobile footer and the desktop card are one component so the two cannot
 * come to show different figures — which they did in legacy, where the footer
 * was passed `isLoading` and the card was not.
 */
export function PaymentSummary({
  quote,
  isQuoting,
  error,
  isStarting,
  onPay,
  compact = false,
}: PaymentSummaryProps) {
  const { lang, t } = useLocale();
  const [open, setOpen] = useState(false);
  const money = (value: string) => formatMoney(value, BASE_CURRENCY, { lang, t });

  const free = quote?.free ?? false;
  const canPay = quote !== null && !isQuoting && !isStarting;
  const charge = quote?.charge ? fromMinor(quote.charge.amountMinor, quote.charge.decimals) : null;

  const lines = quote && (
    <div className="space-y-3">
      {/* The gateway would not take what was left, so the payment was raised —
          and the extra is credited, not kept. `credited` already carries it. */}
      {quote.gap !== "0.00" && (
        <p className="flex items-start gap-2 rounded-2xl border border-gold/20 bg-gold-bg p-3 text-[11px] font-bold leading-relaxed text-gold">
          <Sparkles size={16} className="shrink-0" aria-hidden />
          {t("common", D.gap, { amount: money(quote.gap) })}
        </p>
      )}

      <Row label={t("common", D.amount)} value={money(quote.amount)} />

      {quote.coupons.map((coupon) => (
        <Row
          key={coupon.code}
          label={t("common", D.discount, { code: coupon.code })}
          value={`-${money(coupon.discount)}`}
          tone="primary"
        />
      ))}

      <Row
        label={t("common", D.fee)}
        value={quote.fee === "0.00" ? t("common", D.free) : money(quote.fee)}
        tone={quote.fee === "0.00" ? "primary" : undefined}
      />

      <Row label={t("common", D.credited)} value={money(quote.credited)} />
    </div>
  );

  const total = (
    <div className="flex items-end justify-between gap-3">
      <span className="text-xs font-bold text-text-secondary">{t("common", D.payable)}</span>
      <div className="text-end">
        {quote === null ? (
          <span className="text-sm font-bold text-text-secondary">
            {isQuoting ? t("common", D.quoting) : t("common", D.idle)}
          </span>
        ) : free ? (
          <span className="text-xl font-bold text-primary">{t("common", D.free)}</span>
        ) : (
          <>
            <span dir="ltr" className="block text-2xl font-bold text-gold">
              {money(quote.payable)}
            </span>
            {/* What the bank's own page will say, at the rate that priced this
                quote (ADR-0019). Hidden when the figure cannot be read. */}
            {charge !== null && quote.charge && (
              <span dir="ltr" className="block text-[10px] text-text-secondary">
                {t("common", D.charge, { amount: `${charge} ${quote.charge.currency}` })}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );

  const button = (
    <button
      type="button"
      disabled={!canPay}
      onClick={onPay}
      className={`flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-sm font-bold text-white transition-[filter] disabled:cursor-not-allowed disabled:bg-card-border disabled:text-text-secondary ${
        free ? "bg-primary hover:brightness-110" : "bg-gold hover:brightness-110"
      }`}
    >
      {isStarting ? (
        <>
          <Loader2 size={16} className="animate-spin" aria-hidden />
          {t("common", D.starting)}
        </>
      ) : isQuoting ? (
        <>
          <Loader2 size={16} className="animate-spin" aria-hidden />
          {t("common", D.quoting)}
        </>
      ) : (
        t("common", free ? D.payFree : D.pay)
      )}
    </button>
  );

  const failure = error && (
    <p role="alert" className="text-[11px] font-bold text-error">
      {error}
    </p>
  );

  if (compact) {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center justify-between text-[11px] font-bold text-text-secondary"
        >
          <span className="flex items-center gap-1.5">
            <Receipt size={12} aria-hidden />
            {t("common", D.details)}
          </span>
          <ChevronDown size={14} aria-hidden className={open ? "rotate-180" : ""} />
        </button>
        {open && lines}
        {failure}
        {total}
        {button}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-card-border bg-card-bg shadow-lg">
      <h2 className="flex items-center gap-2 border-b border-card-border bg-bg-inner/40 p-4 text-sm font-bold text-text-primary">
        <span className="flex size-8 items-center justify-center rounded-xl bg-leaf-bg text-primary">
          <Receipt size={16} aria-hidden />
        </span>
        {t("common", D.title)}
      </h2>

      <div className="space-y-4 p-5">
        {lines}
        <div className="border-t border-card-border pt-4">{total}</div>

        {free && (
          <p className="flex items-start gap-2 rounded-2xl border border-primary/20 bg-leaf-bg p-3 text-[11px] font-bold leading-relaxed text-primary">
            <ShieldCheck size={16} className="shrink-0" aria-hidden />
            {t("common", D.freeNotice)}
          </p>
        )}

        {failure}
        {button}

        <p className="flex items-start gap-2 text-[10px] font-bold leading-relaxed text-text-secondary">
          <AlertCircle size={14} className="shrink-0 text-error" aria-hidden />
          {t("common", D.refund)}
        </p>
      </div>
    </div>
  );
}

/** One line of the bill. The value is a string the caller already formatted. */
function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "primary";
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="min-w-0 truncate font-medium text-text-secondary">{label}</span>
      <span dir="ltr" className={`font-bold ${tone === "primary" ? "text-primary" : "text-text-primary"}`}>
        {value}
      </span>
    </div>
  );
}
