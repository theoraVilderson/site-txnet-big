"use client";

import { ResellerDomainsView } from "../../my-resellers/[id]/domains/_components/ResellerDomainsView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/domains` on a reseller's own domain (F-061-n): its domains, as `/my-resellers/:id/domains`. */
export default function Page() {
  return (
    <SelfWorkspace>{(id) => <ResellerDomainsView id={id} />}</SelfWorkspace>
  );
}
