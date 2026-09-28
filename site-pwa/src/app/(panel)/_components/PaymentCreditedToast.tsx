"use client";

import { CheckCircle2, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { userChannel } from "@/lib/realtime";
import { usePanelRealtime } from "../_context/PanelRealtimeContext";
import { usePanelSession } from "../_context/PanelSessionContext";
import { formatMoney } from "../_lib/money";
import { readPaymentCredited, readPaymentReversed } from "../payment/_lib/pending-payment";

const KEYS = {
  credited: FrontendI18nKeys.common.shell.paymentCredited,
  reversed: FrontendI18nKeys.common.shell.paymentReversed,
} as const;

/** Long enough to read once; the balance in the top bar has already changed. */
const VISIBLE_MS = 8_000;

/**
 * "Payment confirmed" when a late credit lands (F-067-l, ADR-0045 decision 3),
 * and "payment reversed" when the gateway returned one (F-067-m, ADR-0046
 * decision 5) — one toast, the last event heard.
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
  const [notice, setNotice] = useState<{ kind: keyof typeof KEYS; amount: string; currency: string } | null>(null);

  useEffect(() => {
    if (!client || !userId) return;
    return client.subscribe(userChannel(userId), {
      onMessage: (payload) => {
        const credited = readPaymentCredited(payload);
        if (credited) return setNotice({ kind: "credited", amount: credited.amountCredited, currency: credited.currencyCode });
        const reversed = readPaymentReversed(payload);
        if (reversed) setNotice({ kind: "reversed", amount: reversed.amountCredited, currency: reversed.currencyCode });
      },
    });
  }, [client, userId]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (notice === null) return null;
  const S = KEYS[notice.kind];
  const Icon = notice.kind === "credited" ? CheckCircle2 : Undo2;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-6 z-50 mx-auto flex max-w-sm items-start gap-3 rounded-2xl border border-primary/20 bg-card-bg p-4 shadow-xl"
    >
      <Icon size={20} aria-hidden className="mt-0.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-bold text-text-primary">{t("common", S.title)}</p>
        <p className="mt-0.5 text-text-secondary">
          {t("common", S.body, { amount: formatMoney(notice.amount, notice.currency, { lang, t }) })}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setNotice(null)}
        aria-label={t("common", S.dismiss)}
        className="rounded-lg p-1 text-text-secondary hover:bg-leaf-bg"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
