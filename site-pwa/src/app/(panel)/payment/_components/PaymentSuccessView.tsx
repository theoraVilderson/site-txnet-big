"use client";

import Link from "next/link";
import { ArrowLeft, History } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_FINANCIAL, PANEL_HOME } from "@/lib/routes";
import { PAYMENT_RESULT_KEYS as P, type PaymentSuccess } from "../_lib/payment-result";
import { PaymentResultCard } from "./PaymentResultCard";
import { ReferenceCard } from "./ReferenceCard";

/** The main action on both result pages. */
export const PRIMARY_ACTION =
  "group relative flex items-center justify-center gap-2 overflow-hidden rounded-2xl bg-primary px-5 py-3.5 text-sm font-bold text-text-on-accent shadow-[0_10px_30px_-10px_var(--accent-glow)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_-10px_var(--accent-glow)] active:translate-y-0 active:scale-[0.98]";

export const SECONDARY_ACTION =
  "flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-medium text-text-secondary transition-colors hover:bg-leaf-bg hover:text-text-primary";

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
      tone="success"
      celebrate={!alreadyPaid}
      title={t("common", alreadyPaid ? P.success.alreadyTitle : P.success.title)}
      message={t("common", alreadyPaid ? P.success.alreadySubtitle : P.success.subtitle)}
      actions={
        <>
          <Link href={PANEL_HOME} className={PRIMARY_ACTION}>
            {t("common", P.success.toPanel)}
            {/* Points forward in the reading direction: left in RTL, right in LTR. */}
            <ArrowLeft
              size={16}
              aria-hidden
              className="transition-transform duration-200 group-hover:-translate-x-1 ltr:rotate-180 ltr:group-hover:translate-x-1"
            />
          </Link>
          <Link href={PANEL_FINANCIAL} className={SECONDARY_ACTION}>
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
