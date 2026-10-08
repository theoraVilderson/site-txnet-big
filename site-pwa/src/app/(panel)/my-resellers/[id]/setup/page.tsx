import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { SetupWizardView } from "./_components/SetupWizardView";

/**
 * `/my-resellers/[id]/setup` — a reseller's setup wizard (UX-2-c, F-213): the
 * onboarding route's steps one at a time. tenant-service admits by the path's
 * reseller (invariant 21); the page shows its refusal otherwise.
 */
export default async function ResellerSetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={2} />
        </div>
      }
    >
      <SetupWizardView id={id} />
    </Suspense>
  );
}
