// A product's renewal rate (F-305-b, catalog `contract.renewal-rate.md`): what
// GiB and days a user types to renew cost, and how few and how many one buys.
import { call, catalogApiPrefix, id, json } from "./catalog-api";

/**
 * One rate row, as `GET /products/:id/renewal-rates` answers it. Prices are
 * decimal strings (C-02) in `currencyCode`; an off row (`isOff`) has all six
 * null — custom renewal switched off from its `effectiveFrom`.
 */
export interface RenewalRateRow {
  id: string;
  isOff: boolean;
  effectiveFrom: string;
  createdAt: string;
  currencyCode: string;
  pricePerGib: string | null;
  pricePerDay: string | null;
  minGib: number | null;
  maxGib: number | null;
  minDays: number | null;
  maxDays: number | null;
}

/** The rate in effect now (`null` = custom renewal off) and the history, newest first, at most 50. */
export interface RenewalRates {
  inEffect: RenewalRateRow | null;
  history: RenewalRateRow[];
}

/** A new rate from `effectiveFrom` (absent = now). A part not sold has a most of 0. */
export interface SetRenewalRateBody {
  pricePerGib: string;
  pricePerDay: string;
  minGib: number;
  maxGib: number;
  minDays: number;
  maxDays: number;
  effectiveFrom?: string;
}

/**
 * The renewal-rate calls for one catalog surface: `null` for the caller's own
 * tenant, a tenant id for the reseller a path names (ADR-0064) — as
 * `catalogAdminApi`. A reseller asking for a platform product's rate is a 404.
 */
export function renewalRateApi(tenantId: string | null) {
  const at = catalogApiPrefix(tenantId);
  const path = (productId: string) => `${at}/products/${id(productId)}/renewal-rates`;
  return {
    async list(productId: string): Promise<RenewalRates> {
      return call<RenewalRates>(path(productId), { method: "GET" });
    },

    /** History: a change is a new row, never an edit; a day already past is refused `price_in_the_past`. */
    async set(productId: string, body: SetRenewalRateBody): Promise<RenewalRateRow> {
      return call<RenewalRateRow>(path(productId), { method: "POST", ...json(body) });
    },

    /** Custom renewal off from `effectiveFrom` (absent = now): a row of its own. */
    async off(productId: string, body: { effectiveFrom?: string }): Promise<RenewalRateRow> {
      return call<RenewalRateRow>(`${path(productId)}/off`, { method: "POST", ...json(body) });
    },
  };
}
