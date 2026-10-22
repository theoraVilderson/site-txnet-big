"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { AlertCircle, Loader2, Wallet, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_DEPOSIT, panelDepositForInvoicePath } from "@/lib/routes";
import { useWalletBalance } from "../../_hooks/useWalletBalance";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import type { Checkout } from "../_hooks/useCheckout";

const S = FrontendI18nKeys.common.shop;

/**
 * The pay half of a checkout (`contract.shop.md` rules 4–7, 9, 11): the code
 * field, the figures, what the wallet can spend, the shortfall's top-up link
 * and the one pay. Drawn from a `useCheckout` state; the shop puts its order
 * beside it, My services' renewal sheet its plans above it.
 *
 * `currency` is what the figures are in before there is an invoice — after,
 * every figure is in the invoice's own (F-116-h3). `onAgain` is the way on from
 * an invoice that can no longer be paid.
 */
export function CheckoutPay({
  co,
  listed,
  currency: listedCurrency,
  startShort = null,
  againLabel,
  onAgain,
}: {
  co: Checkout;
  listed: string | null;
  currency: string;
  /** A metered buy the wallet cannot start (F-118-ah): the top-up it needs first. */
  startShort?: string | null;
  againLabel: string;
  onAgain: () => void;
}) {
  const { t, lang } = useLocale();
  const codeId = useId();
  const money = (value: string, currency: string) => formatMoney(value, currency, { lang, t });
  // What a purchase can spend: billing refuses held money (F-118-a), so the balance would promise more than it pays.
  const { available: balance, currencyCode: walletCurrency } = useWalletBalance();
  const { invoice, open } = co;
  const currency = invoice?.currencyCode ?? listedCurrency;
  const until = invoice ? (formatInstant(invoice.expiresAt, lang) ?? "") : "";

  return (
    <div className="space-y-5">
      {open && co.takesCodes && (
        <div>
          <label htmlFor={codeId} className="mb-1.5 block text-sm font-bold text-text-primary">
            {t("common", S.checkout.codeLabel)}
          </label>
          <div className="flex gap-2">
            <input
              id={codeId}
              value={co.draft}
              onChange={(e) => co.setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  co.addCode();
                }
              }}
              dir="ltr"
              className="min-w-0 flex-1 rounded-2xl border border-card-border bg-bg-inner px-4 py-2.5 text-sm"
            />
            <button
              type="button"
              onClick={co.addCode}
              disabled={co.isBusy}
              className="rounded-2xl border border-card-border px-4 text-sm font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
            >
              {t("common", S.checkout.addCode)}
            </button>
          </div>
          {co.codes.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {co.codes.map((code) => (
                <li key={code} className="flex items-center gap-1 rounded-full bg-leaf-bg px-3 py-1 font-mono text-xs" dir="ltr">
                  {code}
                  <button type="button" disabled={co.isBusy} aria-label={t("common", S.checkout.removeCode, { code })} onClick={() => co.removeCode(code)}>
                    <X size={12} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {co.rejected.length > 0 && (
            <div className="mt-2 rounded-2xl border border-card-border bg-bg-inner p-3 text-xs">
              <p className="mb-1 font-bold text-text-primary">{t("common", S.invoice.rejected)}</p>
              <ul className="space-y-1 text-text-secondary">
                {co.rejected.map((r) => (
                  <li key={r.code}>
                    <span dir="ltr" className="font-mono">
                      {r.code}
                    </span>{" "}
                    — {r.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <dl className="space-y-2 text-sm">
        <Line label={t("common", S.invoice.amount)} value={money(invoice?.amount ?? listed ?? "", currency)} />
        {invoice?.applied.map((a) => <Line key={a.code} label={a.code} value={`− ${money(a.discount, currency)}`} />)}
        <Line label={t("common", S.invoice.total)} value={money(invoice?.total ?? listed ?? "", currency)} strong />
      </dl>

      {balance !== null && walletCurrency !== null && open && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Wallet size={14} aria-hidden />
          <span dir="auto">{t("common", S.checkout.balance, { balance: money(balance, walletCurrency) })}</span>
        </p>
      )}

      {startShort && open && !co.missing && (
        <div role="status" className="rounded-2xl border border-card-border bg-bg-inner p-4 text-sm">
          <p className="font-bold text-text-primary">{t("common", S.meteredStart.title)}</p>
          <p className="mt-1 text-text-secondary">{t("common", S.meteredStart.hint, { amount: money(startShort, walletCurrency ?? currency) })}</p>
          <Link
            href={invoice ? panelDepositForInvoicePath(invoice.id, startShort, invoice.currencyCode) : PANEL_DEPOSIT}
            className="mt-3 inline-block rounded-2xl bg-primary px-4 py-2 font-bold text-on-accent hover:brightness-110"
          >
            {t("common", S.meteredStart.topUp)}
          </Link>
        </div>
      )}

      {invoice && !open && <p className="rounded-2xl bg-bg-inner p-3 text-sm font-bold text-text-primary">{t("common", S.invoice.status[invoice.status])}</p>}
      {invoice && open && <p className="text-xs text-text-secondary">{t("common", S.invoice.expiresAt, { time: until })}</p>}

      {co.priceChanged && (
        <p role="status" className="rounded-2xl bg-bg-inner p-3 text-sm font-bold text-text-primary">
          {t("common", S.checkout.priceChanged)}
        </p>
      )}

      {co.missing && invoice && (
        <div className="rounded-2xl border border-error-border bg-error-bg p-4 text-sm">
          <p className="font-bold text-error">{t("common", S.shortfall.title, { missing: money(co.missing, invoice.currencyCode) })}</p>
          <p className="mt-1 text-text-secondary">{t("common", S.shortfall.hint, { time: until })}</p>
          <Link
            href={panelDepositForInvoicePath(invoice.id, co.missing, invoice.currencyCode)}
            className="mt-3 inline-block rounded-2xl bg-primary px-4 py-2 font-bold text-on-accent hover:brightness-110"
          >
            {t("common", S.shortfall.topUp, { amount: money(co.missing, invoice.currencyCode) })}
          </Link>
        </div>
      )}

      {co.error && <ErrorBox message={co.error.message} errorRef={co.error.ref} />}

      {open ? (
        <button
          type="button"
          onClick={() => void co.pay()}
          disabled={co.isBusy}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-base font-bold text-on-accent hover:brightness-110 disabled:opacity-50"
        >
          {co.isBusy && <Loader2 size={16} className="animate-spin" aria-hidden />}
          {t("common", S.invoice.pay)}
        </button>
      ) : (
        <button type="button" onClick={onAgain} className="block w-full text-center text-sm font-bold text-primary underline">
          {againLabel}
        </button>
      )}
    </div>
  );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "border-t border-card-border pt-2 text-base font-bold text-text-primary" : "text-text-secondary"}`}>
      <dt>{label}</dt>
      <dd dir="ltr">{value}</dd>
    </div>
  );
}

/** Billing's sentence, already translated, with its `ref` (`contract.errors.md`). */
export function ErrorBox({ message, errorRef, children }: { message: string; errorRef?: string; children?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm font-medium text-error">
      <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        {message}
        {errorRef && (
          <span className="mt-1 block font-mono text-3xs opacity-70" dir="ltr">
            {errorRef}
          </span>
        )}
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  );
}
