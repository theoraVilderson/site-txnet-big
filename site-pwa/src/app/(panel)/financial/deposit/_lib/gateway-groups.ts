import type { DepositGateway } from "@/lib/billing-api";
import { settlesItself } from "@/lib/billing/manual-transfer";

/** The picker's two groups, in the order they are drawn (F-803-h). */
export type GatewayGroupId = "automatic" | "manual";

export interface GatewayGroup {
  id: GatewayGroupId;
  gateways: DepositGateway[];
}

/**
 * The gateways as the picker draws them (F-803-h): those that settle
 * themselves first, then those a person confirms — each in the order billing
 * sent, and a group with nothing in it left out so no heading stands alone.
 * Billing already answers in this order (F-803-d); grouping here again keeps
 * the headings true whatever order a list arrives in.
 */
export function groupGateways(gateways: readonly DepositGateway[]): GatewayGroup[] {
  const groups: GatewayGroup[] = [
    { id: "automatic", gateways: gateways.filter(settlesItself) },
    { id: "manual", gateways: gateways.filter((g) => !settlesItself(g)) },
  ];
  return groups.filter((g) => g.gateways.length > 0);
}

/**
 * The gateway the page opens on: the first that settles itself, else the
 * first a person confirms (billing principle 4) — never the slower road while
 * a faster one is offered.
 */
export function defaultGateway(gateways: readonly DepositGateway[]): DepositGateway | null {
  return groupGateways(gateways)[0]?.gateways[0] ?? null;
}
