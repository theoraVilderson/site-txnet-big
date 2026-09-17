import { Suspense } from "react";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { TenantBillingView } from "./_components/TenantBillingView";

/**
 * `/financial/billing` — a reseller's billing wallet with the platform
 * (F-019-d). The `Suspense` is for `useSearchParams`, as on `/financial`.
 */
export default function TenantBillingPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={5} columns={5} withPagination />
        </div>
      }
    >
      <TenantBillingView />
    </Suspense>
  );
}
