import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { ResellerDomainsView } from "./_components/ResellerDomainsView";

/**
 * `/my-resellers/[id]/domains` — a reseller's custom domains (F-066-w2), the
 * first screen of its workspace on the platform panel (ADR-0064 (4)). Anyone
 * signed in may open it; tenant-service admits by the path's reseller
 * (invariant 21) and the page shows its refusal otherwise.
 */
export default async function ResellerDomainsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={3} columns={2} />
        </div>
      }
    >
      <ResellerDomainsView id={id} />
    </Suspense>
  );
}
