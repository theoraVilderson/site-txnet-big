import { redirect } from "next/navigation";

import { PAYMENT_RESULT_SECRET } from "@/env";
import { PANEL_FINANCIAL } from "@/lib/routes";
import { PaymentPendingView } from "../_components/PaymentPendingView";
import { readResultToken } from "../_lib/result-token";

/**
 * `/payment/pending` — where `billing`'s callback redirects a payer whose
 * payment the gateway met with silence (F-093-l, ADR-0044 decision 7). The path
 * is the callback's (`RESULT_PATH.pending`).
 *
 * Like the other two it shows only a signed `?t=` (rule 10); anything else goes
 * to the financial page. Unlike them it is not final: the view polls the
 * payment and becomes the success card when billing credits it.
 */
export default async function PaymentPendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const result = readResultToken(params.t, PAYMENT_RESULT_SECRET);
  if (result?.kind !== "verifying") redirect(PANEL_FINANCIAL);
  return <PaymentPendingView paymentId={result.paymentId} />;
}
