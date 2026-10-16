"use client";

import { AnalyticsView } from "../../analytics/_components/AnalyticsView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/analytics` (F-061-n): the caller's own reseller's analytics, as `/my-resellers/:id/analytics`. */
export default function Page() {
  return <SelfWorkspace>{(id) => <AnalyticsView tenantId={id} self />}</SelfWorkspace>;
}
