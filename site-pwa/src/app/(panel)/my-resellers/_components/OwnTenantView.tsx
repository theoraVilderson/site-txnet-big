"use client";

import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { ResellerUsersView } from "../[id]/users/_components/ResellerUsersView";
import { UserServicesView } from "../[id]/users/[userId]/_components/UserServicesView";

/**
 * `/users[/:userId]` — the session's own tenant's people pages (F-311-ab): the
 * workspace's screens over `me.tenant.id`, with `own` links. The door is the
 * same; only the address says "mine", not "my reseller" (2026-10-09).
 */
export function OwnTenantView({ userId }: { screen: "users"; userId?: string }) {
  const { me } = usePanelSession();
  if (!me)
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
        <TableSkeleton rows={5} columns={3} />
      </div>
    );
  const id = me.tenant.id;
  return userId ? <UserServicesView id={id} userId={userId} own /> : <ResellerUsersView id={id} own />;
}
