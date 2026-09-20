import { ResellerGatewaysView } from "./_components/ResellerGatewaysView";

/**
 * `/my-resellers/[id]/gateways` — a reseller's payment gateways (F-066-w4),
 * the console's gateway step (ADR-0064 (4)). A server shell around one client
 * view, like the ambient gateways page: a half-filled gateway form holds a
 * merchant id, and a URL is the last place one should end up.
 *
 * Anyone signed in may open it; billing admits by the path's reseller
 * (invariant 21) and the page shows its refusal otherwise.
 */
export default async function ResellerGatewaysPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResellerGatewaysView id={id} />;
}
