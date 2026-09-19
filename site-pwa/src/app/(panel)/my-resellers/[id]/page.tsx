import { Suspense } from "react";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { OnboardingConsoleView } from "./_components/OnboardingConsoleView";

/**
 * `/my-resellers/[id]` — a reseller's onboarding console (F-066-w), the
 * workspace's front page on the platform panel (ADR-0064 (4)). Anyone signed
 * in may open it; tenant-service admits by the path's reseller (invariant 21)
 * and the page shows its refusal otherwise.
 */
export default async function ResellerConsolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={2} />
        </div>
      }
    >
      <OnboardingConsoleView id={id} />
    </Suspense>
  );
}
