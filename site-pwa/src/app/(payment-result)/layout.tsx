/**
 * Where the bank returns a payer: `/payment/success` and `/payment/failed`
 * (2026-10-15). Outside `(panel)` on purpose — its session provider sends a
 * signed-out visitor to the login page, and a payer who started in a bot has
 * no panel session in this browser. These pages show only what billing signed
 * into `?t=` (panel-web `contract.payment-result.md` rule 10), so they need
 * none; their "back to the panel" links reach the login page on their own.
 */
export default function PaymentResultLayout({ children }: { children: React.ReactNode }) {
  return <main className="relative flex min-h-screen w-full items-center justify-center">{children}</main>;
}
