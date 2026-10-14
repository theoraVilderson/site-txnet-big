"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { forInvoiceOf } from "../../shop/_lib/shop";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { OwnActOnly } from "../../_components/OwnActOnly";
import { DepositView } from "./_components/DepositView";

/**
 * `/financial/deposit` — the top-up page (F-093-e).
 *
 * A shell around one client view. The only thing on it that is addressable is
 * the shop's hand-off (F-111-e): `?invoice=&missing=&currency=` pre-fills the shortfall
 * and links back to that invoice. An amount the user types, and every coupon
 * code, stay out of the URL — a code in it would sit in the browser history.
 * `useSearchParams` needs the `Suspense` boundary for Next to prerender it.
 * Every link to it lands on one sentence while an admin is signed in as the
 * person: a top-up is their own act (`OwnActOnly`, ADR-0146).
 */
export default function DepositPage() {
  return (
    <OwnActOnly why={FrontendI18nKeys.common.impersonation.ownActDeposit}>
      <Suspense fallback={null}>
        <DepositFromQuery />
      </Suspense>
    </OwnActOnly>
  );
}

function DepositFromQuery() {
  const params = useSearchParams();
  const invoice = params.get("invoice");
  const missing = params.get("missing");
  const currency = params.get("currency");
  // One object per hand-off, so the view's effects run when it changes and not on every render.
  const forInvoice = useMemo(() => forInvoiceOf(invoice, missing, currency), [invoice, missing, currency]);
  return <DepositView forInvoice={forInvoice} />;
}
