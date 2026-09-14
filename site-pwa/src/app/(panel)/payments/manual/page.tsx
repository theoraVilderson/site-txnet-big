import { ManualPaymentsView } from "./_components/ManualPaymentsView";

/**
 * `/payments/manual` — payments the gateway has not confirmed, for a person
 * holding `payment.confirm_manual` (F-093-n, ADR-0044 decision 6).
 *
 * A server shell around one client view, like the gateways page. Billing
 * decides what is listed (the platform owner every tenant's, a tenant its own)
 * and refuses anything outside it; the view decides nothing about scope.
 */
export default function ManualPaymentsPage() {
  return <ManualPaymentsView />;
}
