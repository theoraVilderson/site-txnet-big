import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { ResellerBotView } from "./_components/ResellerBotView";

/**
 * `/my-resellers/[id]/bot` — a reseller's own Telegram or Bale bot
 * (F-066-w6, ADR-0064 (4)), where the onboarding console's bot step is
 * finished. Anyone signed in may open it; auth-service admits by the path's
 * reseller (invariant 21) and the page shows its refusal otherwise.
 */
export default async function ResellerBotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={2} columns={2} />
        </div>
      }
    >
      <ResellerBotView id={id} />
    </Suspense>
  );
}
