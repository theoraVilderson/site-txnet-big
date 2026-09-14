import { redirect } from "next/navigation";

import { PAYMENT_RESULT_SECRET } from "@/env";
import { PANEL_FINANCIAL } from "@/lib/routes";
import { PaymentFailedView } from "../_components/PaymentFailedView";
import { readResultToken } from "../_lib/result-token";

/**
 * `/payment/failed` — where `billing`'s callback redirects a payer whose
 * top-up did not settle (F-093-f). Like the success page it shows only a
 * signed `?t=` (rule 10); `?error=…` typed by hand goes to the financial page.
 */
export default async function PaymentFailedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const result = readResultToken(params.t, PAYMENT_RESULT_SECRET);
  if (result?.kind !== "failed") redirect(PANEL_FINANCIAL);
  return <PaymentFailedView {...result.failure} />;
}
