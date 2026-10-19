"use client";

import { ManualPaymentsView } from "../../payments/manual/_components/ManualPaymentsView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/payments` on a reseller's own domain (F-061-n): its payments to confirm, as `/my-resellers/:id/payments`. */
export default function Page() {
  return <SelfWorkspace>{(id) => <ManualPaymentsView resellerId={id} />}</SelfWorkspace>;
}
