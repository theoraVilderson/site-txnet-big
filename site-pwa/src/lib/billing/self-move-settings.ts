// A tenant's self-move setting, its layer and its products' (network contract.config-move.md "The setting", F-410-a).
import { call } from "./client";

/** Where a value in effect was set: billing's `SelfMoveLayer`. */
export type SelfMoveLayer = "product" | "tenant" | "platform";

/** The two values a user's move is held to: the switch, and the wait between two moves (0 = none). */
export interface SelfMoveValues {
  enabled: boolean;
  cooldownHours: number;
}

/** One layer's own values: null = not set here, inherited from the layer above. */
export interface SelfMoveOwn {
  enabled: boolean | null;
  cooldownHours: number | null;
}

/** Each value in effect and the layer it came from, so the page says "inherited" without computing it. */
export type EffectiveSelfMove = { [K in keyof SelfMoveValues]: { value: SelfMoveValues[K]; layer: SelfMoveLayer } };

/** What every call answers: the whole view, after the write. */
export interface SelfMoveSettingsView {
  platformDefault: SelfMoveValues;
  tenant: SelfMoveOwn;
  /** What a product with no override moves by. */
  effective: EffectiveSelfMove;
  /** The products with an override of their own, at most 500. */
  products: (SelfMoveOwn & { productId: string; effective: EffectiveSelfMove })[];
}

/**
 * `…/tenants/:tenantId/self-move-settings` on the catalog door, by the **path's**
 * tenant. A body always carries both values (billing's schema requires them);
 * a product it may not name is 404 `product_not_found`.
 */
export function selfMoveSettingsApi(tenantId: string) {
  const at = `/tenants/${encodeURIComponent(tenantId)}/self-move-settings`;
  return {
    read: () => call<SelfMoveSettingsView>(at, { method: "GET" }),
    setTenant: (own: SelfMoveOwn) => call<SelfMoveSettingsView>(at, { method: "PUT", body: JSON.stringify(own) }),
    setProduct: (productId: string, own: SelfMoveOwn) =>
      call<SelfMoveSettingsView>(`${at}/products/${encodeURIComponent(productId)}`, { method: "PUT", body: JSON.stringify(own) }),
  };
}
