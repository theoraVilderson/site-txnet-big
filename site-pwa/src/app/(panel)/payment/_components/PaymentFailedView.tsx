"use client";

import Link from "next/link";
import { Info, RefreshCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_DEPOSIT, PANEL_HOME } from "@/lib/routes";
import { PAYMENT_RESULT_KEYS as P, type PaymentFailure } from "../_lib/payment-result";
import { PaymentResultCard } from "./PaymentResultCard";
import { PRIMARY_ACTION, SECONDARY_ACTION } from "./PaymentSuccessView";

/**
 * Where a bank returns a payer whose top-up did not settle (F-093-f).
 *
 * The sentence is chosen from the code on the query string, because no call of
 * ours was answered here — a bank redirected a browser, and a code is all it
 * carried. That makes this the one place the panel writes its own message for a
 * backend failure ([contract.errors.md](../../../../../../docs/interfaces/panel-web/contract.errors.md)).
 *
 * The emblem carries the bad news; the way forward is the panel's own green
 * button, so the page reads as "try again" rather than as an alarm.
 *
 * No support link: `support` has no page yet (`_lib/panel-menu.ts`), and
 * `contract.shell.md` rule 2 is that an entry with no page is hidden rather
 * than made a dead link. Legacy's failure screen linked to one anyway.
 */
export function PaymentFailedView({ code, messageKey }: PaymentFailure) {
  const { t } = useLocale();
  return (
    <PaymentResultCard
      tone="failure"
      title={t("common", P.failure.title)}
      message={t("common", P.failure.subtitle)}
      actions={
        <>
          <Link href={PANEL_DEPOSIT} className={PRIMARY_ACTION}>
            <RefreshCw
              size={16}
              aria-hidden
              className="transition-transform duration-500 group-hover:-rotate-180"
            />
            {t("common", P.failure.retry)}
          </Link>
          <Link href={PANEL_HOME} className={SECONDARY_ACTION}>
            {t("common", P.failure.toPanel)}
          </Link>
        </>
      }
    >
      <div className="mt-7 flex gap-3 rounded-2xl border border-error-border bg-error-bg p-4 text-start">
        <Info size={18} aria-hidden className="mt-0.5 shrink-0 text-error" />
        <div className="min-w-0">
          <p className="text-sm leading-6 font-medium text-text-primary">{t("common", messageKey)}</p>
          {/* Only a code we can explain is printed; `readFailure` drops the rest. */}
          {code !== null && (
            <span
              dir="ltr"
              className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-error-border px-2.5 py-0.5 font-mono text-[10px] tracking-wider text-error"
            >
              {t("common", P.failure.code)}: {code}
            </span>
          )}
        </div>
      </div>
    </PaymentResultCard>
  );
}
