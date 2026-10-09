"use client";

import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { RolesView } from "../[id]/roles/_components/RolesView";
import { TeamView } from "../[id]/team/_components/TeamView";
import { ResellerUsersView } from "../[id]/users/_components/ResellerUsersView";
import { UserServicesView } from "../[id]/users/[userId]/_components/UserServicesView";

/**
 * `/users[/:userId]`, `/team`, `/roles` — the session's own tenant's people
 * pages (F-311-ab, F-1201-c/-d): the workspace's screens over `me.tenant.id`,
 * with `own` links. The door is the same; only the address says "mine", not
 * "my reseller" (2026-10-09).
 */
export function OwnTenantView({ screen, userId }: { screen: "users" | "team" | "roles"; userId?: string }) {
  const { me } = usePanelSession();
  if (!me)
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
        <TableSkeleton rows={5} columns={3} />
      </div>
    );
  const id = me.tenant.id;
  if (screen === "team") return <TeamView id={id} own />;
  if (screen === "roles") return <RolesView id={id} own />;
  return userId ? <UserServicesView id={id} userId={userId} own /> : <ResellerUsersView id={id} own />;
}
