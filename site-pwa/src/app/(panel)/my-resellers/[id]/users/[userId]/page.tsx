import { Suspense } from "react";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { UserServicesView } from "./_components/UserServicesView";

/**
 * `/my-resellers/[id]/users/[userId]` — one user's services as that
 * reseller's admin reads them (F-311-v over F-311-f/g): the list, each
 * Grant's sheet, and the config actions. Billing admits by the path's
 * reseller (invariant 21) and fences the user to it (C-15); the page shows
 * the refusal otherwise.
 */
export default async function UserServicesPage({ params }: { params: Promise<{ id: string; userId: string }> }) {
  const { id, userId } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={3} columns={2} />
        </div>
      }
    >
      <UserServicesView id={id} userId={userId} />
    </Suspense>
  );
}
