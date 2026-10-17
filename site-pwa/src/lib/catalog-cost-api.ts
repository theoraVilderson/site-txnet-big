// A product's cost (F-1002-d, ADR-0151): `/api/catalog[/tenants/:id]/variants/:id/costs`
// and `…/meter-costs`, on the catalog's own client and prefix — a cost is a
// catalog row, private to its tenant.
import { call, catalogApiPrefix, id, json } from "./catalog-api";

/** One row of a cost's history: never edited, a change is a new row from `effectiveFrom`. */
export interface CostRow {
  id: string;
  /** Per sale (a variant), or per `unitSize` units (a meter); a decimal string. `null`: the cost taken back — not set from `effectiveFrom` (F-1002-i). */
  amount: string | null;
  currencyCode: string;
  effectiveFrom: string;
  createdAt: string;
}

export interface MeterCostRow extends CostRow {
  /** `null` with `amount` on a take-back. */
  unitSize: string | null;
}

/** A meter the tenant may cost — never `vpn.traffic`, whose cost is its panels' — with its history, newest first. */
export interface MeterCostLine {
  meterKey: string;
  unit: "bytes" | "count" | "seconds" | "tokens";
  nameKey: string;
  costs: MeterCostRow[];
}

/** `effectiveFrom` absent = now; else no earlier than the 1st of this UTC month (billing refuses a closed month). */
export interface SetVariantCostBody {
  amount: string;
  effectiveFrom?: string;
}

/** A cost taken back from `effectiveFrom` — the same starts as a new cost's. */
export interface UnsetCostBody {
  effectiveFrom?: string;
}

export interface SetMeterCostBody {
  meterKey: string;
  unitSize: string;
  unitCost: string;
  effectiveFrom?: string;
}

/** The cost calls for one catalog surface: `null` for the caller's own tenant, an id for the reseller a route names. */
export function catalogCostApi(tenantId: string | null) {
  const at = catalogApiPrefix(tenantId);
  return {
    variantCosts: (variantId: string) => call<CostRow[]>(`${at}/variants/${id(variantId)}/costs`, { method: "GET" }),
    setVariantCost: (variantId: string, body: SetVariantCostBody) => call<CostRow>(`${at}/variants/${id(variantId)}/costs`, { method: "POST", ...json(body) }),
    meterCosts: () => call<MeterCostLine[]>(`${at}/meter-costs`, { method: "GET" }),
    setMeterCost: (body: SetMeterCostBody) => call<MeterCostRow>(`${at}/meter-costs`, { method: "POST", ...json(body) }),
    unsetVariantCost: (variantId: string, body: UnsetCostBody) => call<CostRow>(`${at}/variants/${id(variantId)}/costs/unset`, { method: "POST", ...json(body) }),
    unsetMeterCost: (meterKey: string, body: UnsetCostBody) => call<MeterCostRow>(`${at}/meter-costs/unset`, { method: "POST", ...json({ meterKey, ...body }) }),
  };
}
