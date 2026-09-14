"use client";

import Link from "next/link";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { WalletPaymentRow } from "@/lib/billing-api";
import { PANEL_FINANCIAL } from "@/lib/routes";
import { BASE_CURRENCY, formatMoney } from "../../../_lib/money";

const V = FrontendI18nKeys.common.deposit.verifying;

/**
 * "A payment is being verified" above the top-up form (F-093-m, ADR-0044
 * decision 7). Says the money is safe and where to watch it; blocks nothing.
 */
export function VerifyingBanner({ payment }: { payment: WalletPaymentRow }) {
  const { lang, t } = useLocale();
  const amount = formatMoney(payment.amountCredited, BASE_CURRENCY, { lang, t });
  return (
    <div role="status" className="mb-6 flex items-start gap-3 rounded-2xl border border-primary/20 bg-leaf-bg p-4 text-sm">
      <ShieldCheck size={20} aria-hidden className="mt-0.5 shrink-0 text-primary" />
      <div className="min-w-0">
        <p className="font-bold text-text-primary">{t("common", V.notice.title)}</p>
        <p className="mt-1 leading-6 text-text-secondary">{t("common", V.notice.body, { amount })}</p>
        <Link href={PANEL_FINANCIAL} className="mt-2 inline-block text-xs font-bold text-primary hover:underline">
          {t("common", V.notice.toFinancial)}
        </Link>
      </div>
    </div>
  );
}

/**
 * The confirm before a second payment (F-093-m). **Warn, not block** — the
 * user's choice (2026-09-14): "pay anyway" always goes through. The safe answer
 * is the prominent one.
 */
export function VerifyingConfirm({
  payment,
  onConfirm,
  onCancel,
}: {
  payment: WalletPaymentRow;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { lang, t } = useLocale();
  const amount = formatMoney(payment.amountCredited, BASE_CURRENCY, { lang, t });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    // Above the sidebar's `z-40`, like the gift modal (`contract.shell.md`).
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-sm" onClick={onCancel}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="verifying-confirm-title"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-sm rounded-3xl border border-card-border bg-card-bg p-6 text-center shadow-xl"
        >
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-error-bg text-error">
            <TriangleAlert size={24} aria-hidden />
          </span>
          <h2 id="verifying-confirm-title" className="mt-4 text-lg font-bold text-text-primary">
            {t("common", V.warn.title)}
          </h2>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{t("common", V.warn.body, { amount })}</p>
          <div className="mt-6 flex flex-col gap-2">
            <button
              type="button"
              autoFocus
              onClick={onCancel}
              className="rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-text-on-accent hover:brightness-110"
            >
              {t("common", V.warn.cancel)}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-2xl px-5 py-3 text-sm font-medium text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
            >
              {t("common", V.warn.confirm)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
