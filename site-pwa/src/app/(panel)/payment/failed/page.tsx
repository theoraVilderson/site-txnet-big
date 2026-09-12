import { PaymentFailedView } from "../_components/PaymentFailedView";
import { readFailure } from "../_lib/payment-result";

/**
 * `/payment/failed` — where `billing`'s callback redirects a payer whose
 * top-up did not settle (F-093-f), carrying `?error=<code>`.
 *
 * Server-read for the same reason as the success page: the params arrive with
 * the redirect, so there is no boundary to cross.
 */
export default async function PaymentFailedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <PaymentFailedView {...readFailure(params.error)} />;
}
