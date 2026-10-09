import { Suspense } from "react";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { OwnUsers } from "../_components/OwnUsers";

/** `/users/[userId]` — one of the session's own users: services and profile. */
export default async function UserPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={3} columns={2} />
        </div>
      }
    >
      <OwnUsers userId={userId} />
    </Suspense>
  );
}
