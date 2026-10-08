"use client";

import { OnboardingConsoleView } from "../my-resellers/[id]/_components/OnboardingConsoleView";
import { SelfWorkspace } from "./_components/SelfWorkspace";

/** `/reseller` on a reseller's own domain (F-061-n): the onboarding console, as `/my-resellers/:id`. */
export default function Page() {
  return (
    <SelfWorkspace>{(id) => <OnboardingConsoleView id={id} />}</SelfWorkspace>
  );
}
