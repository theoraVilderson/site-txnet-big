import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { EffectiveSelfMove, SelfMoveLayer, SelfMoveOwn, SelfMoveSettingsView } from "@/lib/billing-api";

/**
 * The self-move setting's form (F-410-f over billing F-410-a; network
 * `contract.config-move.md` "The setting"): each value says outright whether it
 * follows the layer above or is this layer's own, instead of an empty field
 * meaning "inherit". The resolution is billing's; nothing here decides it.
 */
export const SELF_MOVE_KEYS = FrontendI18nKeys.common.selfMoveSettings;

/** billing's `MAX_SELF_MOVE_COOLDOWN_HOURS`: a year. */
export const MAX_SELF_MOVE_COOLDOWN_HOURS = 8760;

/** What each layer's name reads as, beside an inherited value. */
export const SELF_MOVE_LAYER_KEYS: Record<SelfMoveLayer, string> = {
  product: SELF_MOVE_KEYS.layer.product,
  tenant: SELF_MOVE_KEYS.layer.tenant,
  platform: SELF_MOVE_KEYS.layer.platform,
};

/** The form: the switch inherited, on or off; the wait inherited or this layer's hours, as typed. */
export type SelfMoveChoice = {
  enabled: "inherit" | "on" | "off";
  cooldownMode: "inherit" | "own";
  cooldown: string;
};

function switchOf(enabled: boolean | null): SelfMoveChoice["enabled"] {
  if (enabled === null) return "inherit";
  return enabled ? "on" : "off";
}

/** What a layer holds, as the form shows it. */
export function selfMoveChoiceOf(own: SelfMoveOwn): SelfMoveChoice {
  const enabled = switchOf(own.enabled);
  return own.cooldownHours === null
    ? { enabled, cooldownMode: "inherit", cooldown: "" }
    : { enabled, cooldownMode: "own", cooldown: String(own.cooldownHours) };
}

/** The `PUT` body — both values, null where inherited — or the sentence key of why there is none. */
export function selfMoveBodyOf(choice: SelfMoveChoice, own: SelfMoveOwn): { ok: true; body: SelfMoveOwn } | { ok: false; error: string } {
  let cooldownHours: number | null = null;
  if (choice.cooldownMode === "own") {
    const typed = choice.cooldown.trim();
    const hours = Number(typed);
    if (!/^\d+$/.test(typed) || hours > MAX_SELF_MOVE_COOLDOWN_HOURS) return { ok: false, error: SELF_MOVE_KEYS.invalidHours };
    cooldownHours = hours;
  }
  const body: SelfMoveOwn = { enabled: choice.enabled === "inherit" ? null : choice.enabled === "on", cooldownHours };
  // billing writes nothing for the same values; the page says so instead of a silent "saved".
  if (body.enabled === own.enabled && body.cooldownHours === own.cooldownHours) return { ok: false, error: SELF_MOVE_KEYS.unchanged };
  return { ok: true, body };
}

/** A layer's own values: the tenant's (`productId` null), or a product's override, all null when it has none. */
export function ownOf(view: SelfMoveSettingsView, productId: string | null): SelfMoveOwn {
  if (productId === null) return view.tenant;
  const row = view.products.find((p) => p.productId === productId);
  return row ? { enabled: row.enabled, cooldownHours: row.cooldownHours } : { enabled: null, cooldownHours: null };
}

/** What "inherit" gives at a layer: the platform's default for the tenant, the tenant's in effect for a product. */
export function inheritedOf(view: SelfMoveSettingsView, productId: string | null): EffectiveSelfMove {
  if (productId !== null) return view.effective;
  const d = view.platformDefault;
  return { enabled: { value: d.enabled, layer: "platform" }, cooldownHours: { value: d.cooldownHours, layer: "platform" } };
}

/** A tenant may override only its own products and the platform's it sells (billing refuses another's `product_not_found`). */
export const setsSelfMove = (product: { tenantId: string; platform: boolean }, tenantId: string): boolean =>
  product.platform || product.tenantId === tenantId;
