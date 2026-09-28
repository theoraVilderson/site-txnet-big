import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { ResellerUsersView } from "./_components/ResellerUsersView";

/**
 * `/my-resellers/[id]/users` — a reseller's users (F-311-v over F-311-a), the
 * way into one user's services. Anyone signed in may open it; auth-service
 * admits by the path's reseller (invariant 21) and the page shows its refusal
 * otherwise.
 */
export default async function ResellerUsersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={5} columns={3} />
        </div>
      }
    >
      <ResellerUsersView id={id} />
    </Suspense>
  );
}
