import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { RolesView } from "./_components/RolesView";

/**
 * `/my-resellers/[id]/roles` — a tenant's roles (F-1201-d over F-1201-a). The
 * path names the tenant: a reseller's for its owner and seated admins, the
 * platform's for its staff. auth-service admits by it (ADR-0134) and the page
 * shows its refusal otherwise.
 */
export default async function TenantRolesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={2} />
        </div>
      }
    >
      <RolesView id={id} />
    </Suspense>
  );
}
