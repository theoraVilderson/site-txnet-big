"use client";

import Link from "next/link";
import { History, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi } from "@/lib/billing-api";
import { PANEL_FINANCIAL } from "@/lib/routes";
import { PAYMENT_RESULT_KEYS as P } from "../_lib/payment-result";
import { PENDING_POLL_MS, pendingStateOf, type PendingState } from "../_lib/pending-payment";
import { PaymentResultCard } from "./PaymentResultCard";
import { PaymentSuccessView, SECONDARY_ACTION } from "./PaymentSuccessView";

/**
 * A payment the gateway has not confirmed yet (F-093-l, ADR-0044 decision 7).
 *
 * **The one result page that reads anything.** The other two report an outcome
 * that is already final; this one reports that there is none yet, so it polls
 * the payment (`GET /wallet/payments/:id`) and turns into the success card the
 * moment billing's retries credit it. It settles nothing and asks no gateway —
 * billing does that on its own clock (F-092-x/y).
 *
 * What it must say, above all: the money is safe, and not to pay again.
 */
export function PaymentPendingView({ paymentId }: { paymentId: string }) {
  const { t } = useLocale();
  const [state, setState] = useState<PendingState>({ kind: "waiting" });

  useEffect(() => {
    if (state.kind !== "waiting") return;
    let cancelled = false;
    const check = async () => {
      const row = await billingApi.walletPayment(paymentId).catch(() => null);
      if (!cancelled) setState(pendingStateOf(row));
    };
    void check();
    const timer = setInterval(check, PENDING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paymentId, state.kind]);

  // Credited on this visit: the real celebration, not the quiet "already" one.
  if (state.kind === "credited") return <PaymentSuccessView reference={state.reference} alreadyPaid={false} />;

  const closed = state.kind === "closed";
  return (
    <PaymentResultCard
      tone={closed ? "failure" : "pending"}
      title={t("common", closed ? P.pending.closedTitle : P.pending.title)}
      message={t("common", closed ? P.pending.closedSubtitle : P.pending.subtitle)}
      actions={
        <Link href={PANEL_FINANCIAL} className={SECONDARY_ACTION}>
          <History size={16} aria-hidden />
          {t("common", P.pending.toFinancial)}
        </Link>
      }
    >
      {!closed && (
        <div className="mt-5 space-y-2 rounded-2xl border border-card-border bg-leaf-bg p-4 text-start text-sm leading-6">
          <p className="flex items-start gap-2 text-text-primary">
            <ShieldCheck size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" />
            {t("common", P.pending.safe)}
          </p>
          <p className="font-bold text-text-primary">{t("common", P.pending.doNotPayAgain)}</p>
          <p aria-live="polite" className="text-xs text-text-secondary">
            {t("common", P.pending.checking)}
          </p>
        </div>
      )}
    </PaymentResultCard>
  );
}
