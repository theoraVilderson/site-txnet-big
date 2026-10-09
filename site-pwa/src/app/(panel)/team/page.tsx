import { Suspense } from "react";
import { TableSkeleton } from "../_components/kit/TableSkeleton";
import { OwnTenantView } from "../my-resellers/_components/OwnTenantView";

/** `/team` — the session's own team (F-1201); the menu's entry. */
export default function TeamPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={5} columns={3} />
        </div>
      }
    >
      <OwnTenantView screen="team" />
    </Suspense>
  );
}
