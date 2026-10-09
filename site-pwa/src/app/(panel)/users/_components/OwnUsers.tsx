"use client";

import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { ResellerUsersView } from "../../my-resellers/[id]/users/_components/ResellerUsersView";
import { UserServicesView } from "../../my-resellers/[id]/users/[userId]/_components/UserServicesView";

/**
 * `/users[/:userId]` — the session's own tenant's users (F-311-ab, D-55): the
 * workspace's screens over `me.tenant.id`, with links that stay under `/users`.
 * The door is the same; only the address says "mine", not "my reseller".
 */
export function OwnUsers({ userId }: { userId?: string }) {
  const { me } = usePanelSession();
  if (!me)
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
        <TableSkeleton rows={5} columns={3} />
      </div>
    );
  return userId ? <UserServicesView id={me.tenant.id} userId={userId} own /> : <ResellerUsersView id={me.tenant.id} own />;
}
