"use client";

import Link from "next/link";
import { CheckCircle2, History } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_FINANCIAL, PANEL_HOME } from "@/lib/routes";
import { PAYMENT_RESULT_KEYS as P, type PaymentSuccess } from "../_lib/payment-result";
import { PaymentResultCard } from "./PaymentResultCard";
import { ReferenceCard } from "./ReferenceCard";

/**
 * Where a bank returns a payer whose top-up settled (F-093-f).
 *
 * **This page reports; it does not settle anything.** By the time the browser
 * arrives here `billing`'s callback has already verified with the gateway,
 * credited the wallet under a status guard and written the event
 * (`domains/billing/contract.deposit.md`). There is nothing here to call and
 * nothing to retry — and nothing to add up either: the top bar reads the
 * balance from `billing` on this load like it does on any other.
 */
export function PaymentSuccessView({ reference, alreadyPaid }: PaymentSuccess) {
  const { t } = useLocale();
  return (
    <PaymentResultCard
      icon={CheckCircle2}
      tone="leaf"
      title={t("common", alreadyPaid ? P.success.alreadyTitle : P.success.title)}
      message={t("common", alreadyPaid ? P.success.alreadySubtitle : P.success.subtitle)}
      actions={
        <>
          <Link
            href={PANEL_HOME}
            className="rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-white hover:brightness-110"
          >
            {t("common", P.success.toPanel)}
          </Link>
          <Link
            href={PANEL_FINANCIAL}
            className="flex items-center justify-center gap-2 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            <History size={16} aria-hidden />
            {t("common", P.success.toFinancial)}
          </Link>
        </>
      }
    >
      {reference !== null && <ReferenceCard reference={reference} />}
    </PaymentResultCard>
  );
}
