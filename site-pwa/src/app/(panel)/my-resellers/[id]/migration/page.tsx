import { Suspense } from "react";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { MigrationView } from "./_components/MigrationView";

/**
 * `/my-resellers/[id]/migration` — a reseller's import from another panel
 * (F-201-f, D-63). Anyone signed in may open it; billing and tenant-service
 * admit by the path's reseller and `migration.manage`, and the page shows
 * their refusal otherwise. Suspense: the view reads `?run=`.
 */
export default async function ResellerMigrationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={3} />
        </div>
      }
    >
      <MigrationView id={id} />
    </Suspense>
  );
}
