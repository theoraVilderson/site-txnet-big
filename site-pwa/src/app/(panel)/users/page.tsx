import { Suspense } from "react";
import { TableSkeleton } from "../_components/kit/TableSkeleton";
import { OwnTenantView } from "../my-resellers/_components/OwnTenantView";

/** `/users` — the session's own users (F-311-ab); the menu's "Users". */
export default function UsersPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={5} columns={3} />
        </div>
      }
    >
      <OwnTenantView screen="users" />
    </Suspense>
  );
}
