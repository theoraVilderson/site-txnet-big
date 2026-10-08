"use client";

import { ResellerUsersView } from "../../my-resellers/[id]/users/_components/ResellerUsersView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/users` on a reseller's own domain (F-061-n): its users, as `/my-resellers/:id/users`. */
export default function Page() {
  return <SelfWorkspace>{(id) => <ResellerUsersView id={id} />}</SelfWorkspace>;
}
