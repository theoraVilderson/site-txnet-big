"use client";

import Link from "next/link";
import { useRef } from "react";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { WalletPaymentRow } from "@/lib/billing-api";
import { PANEL_FINANCIAL } from "@/lib/routes";
import { formatMoney } from "../../../_lib/money";
import { Button, Dialog } from "../../../_components/kit";

const V = FrontendI18nKeys.common.deposit.verifying;

/**
 * "A payment is being verified" above the top-up form (F-093-m, ADR-0044
 * decision 7). Says the money is safe and where to watch it; blocks nothing.
 */
export function VerifyingBanner({ payment }: { payment: WalletPaymentRow }) {
  const { lang, t } = useLocale();
  const amount = formatMoney(payment.amountCredited, payment.currencyCode, { lang, t });
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
 * is the prominent one, and it holds the focus when the dialog opens. The frame
 * is the kit's `Dialog` (contract.ux.md K7): Esc and the backdrop are the safe
 * answer too.
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
  const amount = formatMoney(payment.amountCredited, payment.currencyCode, { lang, t });
  const safe = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onCancel}
      size="sm"
      hideClose
      initialFocusRef={safe}
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-error-bg text-error">
            <TriangleAlert size={20} aria-hidden />
          </span>
          {t("common", V.warn.title)}
        </span>
      }
    >
      <p className="text-sm leading-6 text-text-secondary">{t("common", V.warn.body, { amount })}</p>
      <div className="mt-6 flex flex-col gap-2">
        <Button ref={safe} variant="primary" size="lg" fullWidth onClick={onCancel}>
          {t("common", V.warn.cancel)}
        </Button>
        <Button variant="quiet" size="lg" fullWidth onClick={onConfirm}>
          {t("common", V.warn.confirm)}
        </Button>
      </div>
    </Dialog>
  );
}
