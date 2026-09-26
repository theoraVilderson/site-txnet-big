import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { ResellerBrandingView } from "./_components/ResellerBrandingView";

/**
 * `/my-resellers/[id]/branding` — a reseller's brand settings (F-307-k):
 * today the default name of a config line in its buyers' VPN apps. Anyone
 * signed in may open it; tenant-service admits by the path's reseller
 * (invariant 21) and the page shows its refusal otherwise.
 */
export default async function ResellerBrandingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={2} columns={1} />
        </div>
      }
    >
      <ResellerBrandingView id={id} />
    </Suspense>
  );
}
