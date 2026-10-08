"use client";

import { ResellerBotView } from "../../my-resellers/[id]/bot/_components/ResellerBotView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/bot` on a reseller's own domain (F-061-n): its bot, as `/my-resellers/:id/bot`. */
export default function Page() {
  return <SelfWorkspace>{(id) => <ResellerBotView id={id} />}</SelfWorkspace>;
}
