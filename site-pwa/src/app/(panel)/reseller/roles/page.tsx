"use client";

import { RolesView } from "../../my-resellers/[id]/roles/_components/RolesView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/roles` on a reseller's own domain (F-061-n): its roles, as `/my-resellers/:id/roles` (F-1201-d). */
export default function Page() {
  return <SelfWorkspace>{(id) => <RolesView id={id} />}</SelfWorkspace>;
}
