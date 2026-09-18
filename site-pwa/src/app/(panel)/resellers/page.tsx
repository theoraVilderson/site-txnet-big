import { Suspense } from "react";
import { TableSkeleton } from "../_components/kit/TableSkeleton";
import { ResellersView } from "./_components/ResellersView";

/**
 * `/resellers` — the platform owner's reseller administration (F-018-k). The
 * `Suspense` is for `useSearchParams`, as on `/financial/billing`.
 */
export default function ResellersPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={5} columns={6} />
        </div>
      }
    >
      <ResellersView />
    </Suspense>
  );
}
