"use client";

import Link from "next/link";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_DEPOSIT, PANEL_HOME } from "@/lib/routes";
import { PAYMENT_RESULT_KEYS as P, type PaymentFailure } from "../_lib/payment-result";
import { PaymentResultCard } from "./PaymentResultCard";

/**
 * Where a bank returns a payer whose top-up did not settle (F-093-f).
 *
 * The sentence is chosen from the code on the query string, because no call of
 * ours was answered here — a bank redirected a browser, and a code is all it
 * carried. That makes this the one place the panel writes its own message for a
 * backend failure ([contract.errors.md](../../../../../../docs/interfaces/panel-web/contract.errors.md)).
 *
 * No support link: `support` has no page yet (`_lib/panel-menu.ts`), and
 * `contract.shell.md` rule 2 is that an entry with no page is hidden rather
 * than made a dead link. Legacy's failure screen linked to one anyway.
 */
export function PaymentFailedView({ code, messageKey }: PaymentFailure) {
  const { t } = useLocale();
  return (
    <PaymentResultCard
      icon={AlertCircle}
      tone="error"
      title={t("common", P.failure.title)}
      message={t("common", P.failure.subtitle)}
      actions={
        <>
          <Link
            href={PANEL_DEPOSIT}
            className="flex items-center justify-center gap-2 rounded-2xl bg-error px-5 py-3 text-sm font-bold text-white hover:brightness-110"
          >
            <RefreshCw size={16} aria-hidden />
            {t("common", P.failure.retry)}
          </Link>
          <Link
            href={PANEL_HOME}
            className="py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            {t("common", P.failure.toPanel)}
          </Link>
        </>
      }
    >
      <div className="mt-6 rounded-2xl border border-error-border bg-error-bg p-4 text-start">
        <p className="text-sm font-medium text-text-primary">{t("common", messageKey)}</p>
        {/* Only a code we can explain is printed; `readFailure` drops the rest. */}
        {code !== null && (
          <p dir="ltr" className="mt-1 font-mono text-[10px] tracking-wider text-error">
            {t("common", P.failure.code)}: {code}
          </p>
        )}
      </div>
    </PaymentResultCard>
  );
}
