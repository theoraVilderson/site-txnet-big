"use client";

import { AccessLogView } from "../../my-resellers/[id]/access-log/_components/AccessLogView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/access-log` on a reseller's own domain: its access log, as `/my-resellers/:id/access-log` (AC-1-p). */
export default function Page() {
  return <SelfWorkspace>{(id) => <AccessLogView id={id} />}</SelfWorkspace>;
}
