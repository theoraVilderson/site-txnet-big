"use client";

import { useCallback, useState } from "react";
import { Loader2, RotateCw, ShieldCheck } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { ManualAnswer } from "@/lib/billing-api";
import { useOpenPayments } from "../_hooks/useOpenPayments";
import { MANUAL_KEYS as K, OUTCOME_KEYS } from "../_lib/manual-confirm";
import { PageHeader } from "../../../_components/kit/PageHeader";
import { Button } from "../../../_components/kit";
import { ManualPaymentItem } from "./ManualPaymentItem";

/**
 * The manual confirmation screen (F-093-n, ADR-0044 decision 6) — what
 * replaces legacy's off-the-books manual top-up. Since F-093-o it lists every
 * open payment (ADR-0046 decision 7), badged by state, and takes a lost
 * authority by hand.
 *
 * **Inquire, then confirm.** Each payment offers "ask the gateway" first. Only
 * when that answers `unsettled` does the hand-confirm form appear, asking for
 * the gateway's reference number and a reason. Billing asks the gateway once
 * more before it credits, so a payment that settled in between is settled by
 * the gateway, not by the person.
 *
 * Nothing is patched into the list from an answer: after every inquire or
 * confirm the list is read again, because billing decides what the payment
 * became. A manual transfer skips the asking — it has no gateway — and is
 * judged by its proof (F-803-k, `ManualPaymentItem`).
 *
 * `resellerId`: a reseller's workspace (F-093-w) — the same screen over that
 * reseller's queue (F-093-v); absent, the session's own.
 */
export function ManualPaymentsView({ resellerId = null }: { resellerId?: string | null }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { api, rows, isLoading, error, reload } = useOpenPayments(resellerId);
  // The row a settled answer was about leaves the list on reload; its sentence stays here.
  const [notice, setNotice] = useState<ManualAnswer | null>(null);

  const settled = useCallback(
    async (answer: ManualAnswer) => {
      setNotice(answer);
      await reload();
    },
    [reload],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
      />

      {notice && (
        <p role="status" className="rounded-xl border border-card-border bg-card-bg p-3 text-xs font-bold text-text-primary">
          {t("common", OUTCOME_KEYS[notice.outcome])}
          {notice.referenceId && (
            <span dir="ltr" className="ms-2 font-mono font-normal text-text-secondary">
              {notice.referenceId}
            </span>
          )}
        </p>
      )}

      <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
        {isLoading ? (
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {t("common", K.loading)}
          </p>
        ) : error ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-xs font-bold text-error">
              {errorMessage(error)}
            </p>
            <Button variant="quiet" size="sm" onClick={() => void reload()} icon={<RotateCw size={14} aria-hidden />} className="text-primary hover:text-primary">
              {t("common", K.retry)}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-secondary">{t("common", K.empty)}</p>
        ) : (
          <ul className="divide-y divide-card-border">
            {rows.map((row) => (
              <ManualPaymentItem key={row.id} row={row} api={api} onSettled={settled} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
