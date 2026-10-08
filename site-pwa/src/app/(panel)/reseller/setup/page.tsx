"use client";

import { SetupWizardView } from "../../my-resellers/[id]/setup/_components/SetupWizardView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/setup` (F-061-n): the setup wizard, as `/my-resellers/:id/setup` (UX-2-c). */
export default function Page() {
  return (
    <SelfWorkspace>{(id) => <SetupWizardView id={id} />}</SelfWorkspace>
  );
}
