"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { forInvoiceOf } from "../../shop/_lib/shop";
import { DepositView } from "./_components/DepositView";

/**
 * `/financial/deposit` — the top-up page (F-093-e).
 *
 * A shell around one client view. The only thing on it that is addressable is
 * the shop's hand-off (F-111-e): `?invoice=&missing=` pre-fills the shortfall
 * and links back to that invoice. An amount the user types, and every coupon
 * code, stay out of the URL — a code in it would sit in the browser history.
 * `useSearchParams` needs the `Suspense` boundary for Next to prerender it.
 */
export default function DepositPage() {
  return (
    <Suspense fallback={null}>
      <DepositFromQuery />
    </Suspense>
  );
}

function DepositFromQuery() {
  const params = useSearchParams();
  const invoice = params.get("invoice");
  const missing = params.get("missing");
  // One object per hand-off, so the view's effects run when it changes and not on every render.
  const forInvoice = useMemo(() => forInvoiceOf(invoice, missing), [invoice, missing]);
  return <DepositView forInvoice={forInvoice} />;
}
