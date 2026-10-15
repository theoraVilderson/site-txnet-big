"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Hourglass, ShoppingBag, Wallet, XCircle } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type TransferStatus, type WalletBalance } from "@/lib/billing-api";
import { PANEL_FINANCIAL, PANEL_SHOP } from "@/lib/routes";
import { AnimatedNumber, buttonClass, useCelebration } from "../../../_components/kit";
import { formatMoney } from "../../../_lib/money";
import { PAY_KEYS, checkingText, payerReasonKey } from "../_lib/transfer-page";

/**
 * A proof with a person (contract "Checking"): a soft halo on the step, the
 * sentence for the gateway's mode, and why it waits when billing says more
 * than "a person checks the proof".
 */
export function CheckingPanel({ transfer }: { transfer: Pick<TransferStatus, "confirmationMode" | "confirmWithinMinutes" | "reviewReason"> }) {
  const { t } = useLocale();
  const waiting = checkingText(transfer);
  const reason = transfer.reviewReason === "proof_only" ? null : payerReasonKey(transfer.reviewReason);
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="relative grid size-16 place-items-center">
        <span aria-hidden className="transfer-halo absolute inset-0 rounded-full bg-info-bg" />
        <Hourglass size={26} aria-hidden className="relative text-info" />
      </span>
      <h2 className="text-base font-bold text-text-primary">{t("common", PAY_KEYS.checking.title)}</h2>
      <p className="max-w-sm text-sm leading-6 text-text-secondary">
        {t("common", waiting.key, waiting.vars)}
      </p>
      {reason && <p className="max-w-sm text-sm font-bold text-warning">{t("common", reason)}</p>}
    </div>
  );
}

/**
 * Credited (contract "Credited"): the wallet's new balance counts up, a short
 * confetti burst (none under reduced motion — `celebrate` reads the level), and
 * the way back to the wallet or on to the shop.
 */
export function CreditedPanel() {
  const { lang, t } = useLocale();
  const [wallet, setWallet] = useState<WalletBalance | null>(null);
  useCelebration(true);

  useEffect(() => {
    // The balance is a flourish under the fact already shown; a failed read only leaves it out.
    billingApi.walletBalance().then(setWallet, () => setWallet(null));
  }, []);

  const balance = wallet ? Number(wallet.balance) : null;
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <h2 className="text-lg font-bold text-text-primary">{t("common", PAY_KEYS.credited.title)}</h2>
      {wallet && balance !== null && Number.isFinite(balance) && (
        <div className="flex flex-col items-center">
          <span className="text-xs text-text-secondary">{t("common", PAY_KEYS.credited.balance)}</span>
          <span dir="ltr" className="text-2xl font-black text-text-primary">
            <AnimatedNumber value={balance} format={(n) => formatMoney(n >= balance ? wallet.balance : n, wallet.currencyCode, { lang, t })} />
          </span>
        </div>
      )}
      <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row">
        <Link href={PANEL_FINANCIAL} className={buttonClass({ variant: "primary", fullWidth: true })}>
          <Wallet size={16} aria-hidden />
          {t("common", PAY_KEYS.credited.toWallet)}
        </Link>
        <Link href={PANEL_SHOP} className={buttonClass({ fullWidth: true })}>
          <ShoppingBag size={16} aria-hidden />
          {t("common", PAY_KEYS.credited.toShop)}
        </Link>
      </div>
    </div>
  );
}

/** Closed without a credit: a person rejected it, or its time and grace ran out. */
export function ClosedPanel({ status }: { status: TransferStatus["status"] }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <XCircle size={36} aria-hidden className="text-error" />
      <p className="max-w-sm text-sm leading-6 text-text-primary">{t("common", status === "expired" ? PAY_KEYS.closed.expired : PAY_KEYS.closed.failed)}</p>
      <Link href={PANEL_FINANCIAL} className={buttonClass({})}>
        {t("common", PAY_KEYS.credited.toWallet)}
      </Link>
    </div>
  );
}
