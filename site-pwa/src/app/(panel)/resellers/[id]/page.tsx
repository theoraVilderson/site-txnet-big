import { Suspense } from "react";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { ResellerDetailView } from "./_components/ResellerDetailView";

/**
 * `/resellers/[id]` — one reseller (F-019-k). The list opens it; everything
 * the platform owner does to a single reseller lives here, in tabs, rather
 * than in a sheet over the list. The `Suspense` is for `useSearchParams`
 * (`?tab=`, `?page=`), as on `/resellers`.
 */
export default async function ResellerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={2} />
        </div>
      }
    >
      <ResellerDetailView id={id} />
    </Suspense>
  );
}
