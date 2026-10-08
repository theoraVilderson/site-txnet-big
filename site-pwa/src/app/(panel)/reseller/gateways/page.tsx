"use client";

import { ResellerGatewaysView } from "../../my-resellers/[id]/gateways/_components/ResellerGatewaysView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/gateways` on a reseller's own domain (F-061-n): its payment gateways, as `/my-resellers/:id/gateways`. */
export default function Page() {
  return (
    <SelfWorkspace>{(id) => <ResellerGatewaysView id={id} />}</SelfWorkspace>
  );
}
