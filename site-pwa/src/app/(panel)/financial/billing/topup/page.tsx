import { TenantTopupView } from "./_components/TenantTopupView";

/**
 * `/financial/billing/topup` — a reseller tops up its billing wallet with the
 * platform (F-019-e). No `Suspense`: nothing on it is addressable, as on
 * `/financial/deposit`.
 */
export default function TenantTopupPage() {
  return <TenantTopupView />;
}
