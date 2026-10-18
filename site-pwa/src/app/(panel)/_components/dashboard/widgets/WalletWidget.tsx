"use client";

import Link from "next/link";
import { CreditCard, Gift } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_DEPOSIT } from "@/lib/routes";
import { useWalletBalance } from "../../../_hooks/useWalletBalance";
import { currencyDecimals, formatMoney, isNonZero } from "../../../_lib/money";
import { usePanelUiStore } from "../../../_stores/panel-ui-store";
import { AnimatedNumber, Button } from "../../kit";
import type { WidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;

type Wallet = { balance: string; held: string | null; currencyCode: string };

/**
 * The wallet (UX-1-q, D4): the balance counting up once, what is held for the
 * user's services apart from it, top up and gift code. The figures are the
 * top bar's own (`useWalletBalance`): billing's, re-read on a wallet event.
 */
export default function WalletWidget() {
  const { t, lang } = useLocale();
  const openGiftCode = usePanelUiStore((s) => s.setGiftCodeOpen);
  const { balance, held, currencyCode, isLoading, failed, refresh } = useWalletBalance();
  const source: WidgetSource<Wallet> =
    balance !== null && currencyCode !== null
      ? { state: "ready", data: { balance, held, currencyCode }, retry: refresh }
      : failed && !isLoading
        ? { state: "error", retry: refresh }
        : { state: "loading", retry: refresh };

  return (
    <WidgetBody source={source}>
      {(w) => (
        <div className="flex h-full flex-col gap-3">
          <p className="text-2xl font-black tabular-nums text-text-primary" dir="ltr">
            <AnimatedNumber value={Number(w.balance)} format={(n) => formatMoney(n.toFixed(currencyDecimals(w.currencyCode)), w.currencyCode, { lang, t })} />
          </p>
          {isNonZero(w.held) && (
            <p className="text-xs text-text-secondary">{t("common", D.wallet.held, { amount: formatMoney(w.held, w.currencyCode, { lang, t }) })}</p>
          )}
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <Link
              href={PANEL_DEPOSIT}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-bold text-on-accent hover:brightness-105"
            >
              <CreditCard size={14} aria-hidden />
              {t("common", D.quick.topUp)}
            </Link>
            <Button size="sm" variant="secondary" icon={<Gift size={14} aria-hidden />} onClick={() => openGiftCode(true)}>
              {t("common", D.quick.giftCode)}
            </Button>
          </div>
        </div>
      )}
    </WidgetBody>
  );
}
