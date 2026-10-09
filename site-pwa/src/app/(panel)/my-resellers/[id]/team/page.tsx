import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { TeamView } from "./_components/TeamView";

/**
 * `/my-resellers/[id]/team` — a tenant's team (F-1201-c): a reseller's seats
 * for its owner and seated admins, the platform's staff for its own staff. The
 * path names the tenant; the services admit by it and the page shows their
 * refusal otherwise.
 */
export default async function TenantTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={3} />
        </div>
      }
    >
      <TeamView id={id} />
    </Suspense>
  );
}
