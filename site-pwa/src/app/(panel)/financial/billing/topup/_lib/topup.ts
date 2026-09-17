import type { DepositGateway, TenantTopupBody } from "@/lib/billing-api";
import { fromCents, toCents } from "../../../deposit/_lib/deposit-amount";

/**
 * The body for a billing top-up (F-019-e), or `null` when there is nothing
 * worth sending: no gateway, an amount that is not one (`10.`, `0`), or one
 * outside the side of the gateway's range it set.
 *
 * No `source` and no `couponCodes`: the route pins the source to `platform`
 * and refuses a coupon, so the user deposit's body is a 400 here
 * (`tenant/contract.billing.md`). The range check spares a start from the
 * deposit bucket; the service is still the one that decides.
 */
export function topupBody(gateway: DepositGateway | null, amount: string): TenantTopupBody | null {
  if (!gateway) return null;
  const cents = toCents(amount);
  if (cents === null || cents <= 0) return null;
  const min = gateway.minAmount ? toCents(gateway.minAmount) : null;
  const max = gateway.maxAmount ? toCents(gateway.maxAmount) : null;
  if (min !== null && cents < min) return null;
  if (max !== null && cents > max) return null;
  return { gatewayId: gateway.id, amount: fromCents(cents) };
}
