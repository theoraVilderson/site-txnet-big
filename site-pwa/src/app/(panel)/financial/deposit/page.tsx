import { DepositView } from "./_components/DepositView";

/**
 * `/financial/deposit` — the top-up page (F-093-e).
 *
 * A server shell around one client view. There is no `useSearchParams` here and
 * so no `Suspense` boundary: unlike the financial history page, nothing on this
 * screen is addressable — an amount half-typed into a box is not a link worth
 * having, and putting it in the URL would put a user's coupon codes in their
 * browser history.
 */
export default function DepositPage() {
  return <DepositView />;
}
