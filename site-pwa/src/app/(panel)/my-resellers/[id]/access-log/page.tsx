import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { AccessLogView } from "./_components/AccessLogView";

/**
 * `/my-resellers/[id]/access-log` — every act that moved someone's access in
 * this tenant (AC-1-p). auth-service admits by `audit.read` (the owner and the
 * platform's staff always) and the page shows its refusal otherwise.
 */
export default async function AccessLogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={2} />
        </div>
      }
    >
      <AccessLogView id={id} />
    </Suspense>
  );
}
