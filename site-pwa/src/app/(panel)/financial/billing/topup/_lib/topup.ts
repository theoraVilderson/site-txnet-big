import type { DepositGateway, TenantTopupBody } from "@/lib/billing-api";
import { currencyDecimals } from "../../../../_lib/money";
import { fromMinorNumber, toMinor } from "../../../deposit/_lib/deposit-amount";

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
  // In the gateway currency's minor units: a rial takes no fraction, a dinar three (F-116-s).
  const decimals = currencyDecimals(gateway.currencyCode);
  const minor = toMinor(amount, decimals);
  if (minor === null || minor <= 0) return null;
  const min = gateway.minAmount ? toMinor(gateway.minAmount, decimals) : null;
  const max = gateway.maxAmount ? toMinor(gateway.maxAmount, decimals) : null;
  if (min !== null && minor < min) return null;
  if (max !== null && minor > max) return null;
  return { gatewayId: gateway.id, amount: fromMinorNumber(minor, decimals) };
}
