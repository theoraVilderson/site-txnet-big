"use client";

import { ResellerSettingsView } from "../../my-resellers/[id]/settings/_components/ResellerSettingsView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/settings` (F-061-n): its settings, as `/my-resellers/:id/settings` (UX-2-b). */
export default function Page() {
  return (
    <SelfWorkspace>{(id) => <ResellerSettingsView id={id} />}</SelfWorkspace>
  );
}
