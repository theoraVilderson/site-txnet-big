"use client";

import { GroupsView } from "../../groups/_components/GroupsView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/groups` on a reseller's own domain (F-061-n): its groups, as `/my-resellers/:id/groups` (GR-1-f). */
export default function Page() {
  return <SelfWorkspace>{(id) => <GroupsView tenantId={id} />}</SelfWorkspace>;
}
