import { redirect } from "next/navigation";

import { PAYMENT_RESULT_SECRET } from "@/env";
import { PANEL_FINANCIAL } from "@/lib/routes";
import { PaymentSuccessView } from "../_components/PaymentSuccessView";
import { readResultToken } from "../_lib/result-token";

/**
 * `/payment/success` — where `billing`'s callback redirects a payer whose
 * top-up settled (F-093-f). The path is the callback's, not this app's
 * preference: `deposit-callback.controller.ts` writes it out.
 *
 * Shows **only** what billing signed into `?t=` (rule 10). A hand-typed
 * `?ref=…`, a forged or expired token, or a failure token opened here is sent
 * to the financial page, where the real row is — never a success on screen.
 *
 * Read on the server, not with `useSearchParams`: the params exist before the
 * first paint, and the secret must never reach the browser.
 */
export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const result = readResultToken(params.t, PAYMENT_RESULT_SECRET);
  if (result?.kind !== "success") redirect(PANEL_FINANCIAL);
  return <PaymentSuccessView {...result.success} />;
}
