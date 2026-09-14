"use client";

import { CheckCircle2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { userChannel } from "@/lib/realtime";
import { usePanelRealtime } from "../_context/PanelRealtimeContext";
import { usePanelSession } from "../_context/PanelSessionContext";
import { BASE_CURRENCY, formatMoney } from "../_lib/money";
import { readPaymentCredited } from "../payment/_lib/pending-payment";

const S = FrontendI18nKeys.common.shell.paymentCredited;

/** Long enough to read once; the balance in the top bar has already changed. */
const VISIBLE_MS = 8_000;

/**
 * "Payment confirmed" when a late credit lands (F-067-l, ADR-0045 decision 3).
 *
 * Mounted at the panel layout, beside the one socket, so it is heard on any
 * screen. It only speaks for the event it can read — `readPaymentCredited`
 * ignores everything else on the channel — and it never touches the balance:
 * `useWalletBalance` re-reads on the same event (`contract.shell.md` rule 1).
 * The worker sends it only for credits the payer did not watch land.
 */
export function PaymentCreditedToast() {
  const { lang, t } = useLocale();
  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const client = usePanelRealtime();
  const [amount, setAmount] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !userId) return;
    return client.subscribe(userChannel(userId), {
      onMessage: (payload) => {
        const credited = readPaymentCredited(payload);
        if (credited) setAmount(credited.amountCredited);
      },
    });
  }, [client, userId]);

  useEffect(() => {
    if (amount === null) return;
    const timer = setTimeout(() => setAmount(null), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [amount]);

  if (amount === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-6 z-50 mx-auto flex max-w-sm items-start gap-3 rounded-2xl border border-primary/20 bg-card-bg p-4 shadow-xl"
    >
      <CheckCircle2 size={20} aria-hidden className="mt-0.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-bold text-text-primary">{t("common", S.title)}</p>
        <p className="mt-0.5 text-text-secondary">
          {t("common", S.body, { amount: formatMoney(amount, BASE_CURRENCY, { lang, t }) })}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setAmount(null)}
        aria-label={t("common", S.dismiss)}
        className="rounded-lg p-1 text-text-secondary hover:bg-leaf-bg"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
