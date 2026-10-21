"use client";

import { MigrationView } from "../../my-resellers/[id]/migration/_components/MigrationView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/migration` on a reseller's own domain (F-061-n): its import from another panel, as `/my-resellers/:id/migration`. */
export default function Page() {
  return <SelfWorkspace>{(id) => <MigrationView id={id} />}</SelfWorkspace>;
}
