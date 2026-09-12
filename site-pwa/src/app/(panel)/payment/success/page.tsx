import { PaymentSuccessView } from "../_components/PaymentSuccessView";
import { readSuccess } from "../_lib/payment-result";

/**
 * `/payment/success` — where `billing`'s callback redirects a payer whose
 * top-up settled (F-093-f). The path is the callback's, not this app's
 * preference: `deposit-callback.controller.ts` writes it out.
 *
 * The query string is read **here**, on the server, rather than with
 * `useSearchParams` in the view: this page is the end of a redirect, so its
 * params exist before the first paint and there is nothing to suspend on.
 * Legacy wrapped the whole screen in a `Suspense` boundary for a hook it did
 * not need, and the fallback was the first thing a paying user saw.
 */
export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <PaymentSuccessView {...readSuccess(params.ref, params.already)} />;
}
