import { ManualPaymentsView } from "../../../payments/manual/_components/ManualPaymentsView";

/**
 * `/my-resellers/[id]/payments` — a reseller's payments to confirm (F-093-w):
 * the `/payments/manual` screen over the route that names the reseller
 * (F-093-v). Anyone signed in may open it; billing admits by the path's
 * reseller (invariant 21) and the page shows its refusal otherwise.
 */
export default async function ResellerPaymentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ManualPaymentsView resellerId={id} />;
}
