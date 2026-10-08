import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { ResellerSettingsView } from "./_components/ResellerSettingsView";

/**
 * `/my-resellers/[id]/settings` — a reseller's settings (UX-2-b): currency,
 * time zone, limits and quotas, package change, support access. Anyone signed
 * in may open it; each card's service admits by the path's reseller
 * (invariant 21) and the card shows its refusal otherwise.
 */
export default async function ResellerSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={2} />
        </div>
      }
    >
      <ResellerSettingsView id={id} />
    </Suspense>
  );
}
