"use client";

import { TeamView } from "../../my-resellers/[id]/team/_components/TeamView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/team` on a reseller's own domain (F-061-n): its team, as `/my-resellers/:id/team` (F-1201-c). */
export default function Page() {
  return <SelfWorkspace>{(id) => <TeamView id={id} />}</SelfWorkspace>;
}
