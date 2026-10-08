"use client";

import { ResellerBrandingView } from "../../my-resellers/[id]/branding/_components/ResellerBrandingView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/branding` on a reseller's own domain (F-061-n): its brand, as `/my-resellers/:id/branding`. */
export default function Page() {
  return (
    <SelfWorkspace>{(id) => <ResellerBrandingView id={id} />}</SelfWorkspace>
  );
}
