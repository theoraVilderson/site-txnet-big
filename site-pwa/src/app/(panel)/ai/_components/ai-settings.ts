import type { AiActionType, AiSettings, AiSettingsPatch, AiTypeActivity } from "@/lib/ai-api";

/**
 * The threshold as three plain levels (F-038-j4, user 2026-10-18): an admin
 * picks how bold the engine is, not a number. `balanced` is ai's default
 * (ADR-0109 point 8); the number itself stays under "advanced".
 */
export const THRESHOLD_LEVELS = { careful: "0.70", balanced: "0.60", more: "0.50" } as const;
export type ThresholdLevel = keyof typeof THRESHOLD_LEVELS;
export const LEVEL_ORDER: readonly ThresholdLevel[] = ["careful", "balanced", "more"];

/** The level a threshold is, or null for a number no level names. */
export function levelOf(threshold: string): ThresholdLevel | null {
  return LEVEL_ORDER.find((l) => Number(THRESHOLD_LEVELS[l]) === Number(threshold)) ?? null;
}

/**
 * How much of a type a threshold holds back, judged on the confidences ai
 * recorded for it (F-038-j3) — the engine's rules are never restated here.
 * `null` when there is nothing to judge on.
 */
export function heldBy(activity: AiTypeActivity | undefined, threshold: string): "none" | "partly" | "all" | null {
  if (!activity?.confidence) return null;
  const t = Number(threshold);
  if (Number(activity.confidence.max) < t) return "all";
  return Number(activity.confidence.min) < t ? "partly" : "none";
}

export type TypeState =
  | { kind: "off" }
  | { kind: "notAvailable" }
  | { kind: "needsOffer" }
  | { kind: "silenced" }
  | { kind: "partly" }
  | { kind: "sent"; count: number }
  | { kind: "idle" };

/** What one type's row says, most blocking first. `null` while the activity is unknown. */
export function typeState(on: boolean, activity: AiTypeActivity | undefined, threshold: string): TypeState | null {
  if (!on) return { kind: "off" };
  if (!activity) return null;
  if (activity.waitsOn === "not_available") return { kind: "notAvailable" };
  if (activity.waitsOn === "active_offer") return { kind: "needsOffer" };
  const held = heldBy(activity, threshold);
  if (held === "all") return { kind: "silenced" };
  if (held === "partly") return { kind: "partly" };
  return activity.sent > 0 ? { kind: "sent", count: activity.sent } : { kind: "idle" };
}

/** The switched-on types a threshold would silence entirely, in the settings' order. */
export function silencedTypes(types: readonly AiActionType[], disabled: ReadonlySet<AiActionType>, activity: readonly AiTypeActivity[], threshold: string): AiActionType[] {
  return types.filter((type) => !disabled.has(type) && heldBy(activity.find((a) => a.type === type), threshold) === "all");
}

export type Draft = { engineEnabled: boolean; confidenceThreshold: string; holdoutPercent: string; disabled: Set<AiActionType> };

export const draftOf = (s: AiSettings): Draft => ({
  engineEnabled: s.engineEnabled,
  confidenceThreshold: s.confidenceThreshold,
  holdoutPercent: String(s.holdoutPercent),
  disabled: new Set(s.disabledActionTypes),
});

/**
 * Only what changed is sent: a save never writes back a value another admin
 * changed meanwhile (panel-web contract.ai.md rule 2).
 */
export function patchOf(saved: AiSettings, d: Draft): AiSettingsPatch {
  const patch: AiSettingsPatch = {};
  if (d.engineEnabled !== saved.engineEnabled) patch.engineEnabled = d.engineEnabled;
  if (Number(d.confidenceThreshold) !== Number(saved.confidenceThreshold)) patch.confidenceThreshold = d.confidenceThreshold;
  if (Number(d.holdoutPercent) !== saved.holdoutPercent) patch.holdoutPercent = Number(d.holdoutPercent);
  const before = new Set(saved.disabledActionTypes);
  if (d.disabled.size !== before.size || [...d.disabled].some((x) => !before.has(x))) {
    patch.disabledActionTypes = saved.actionTypes.filter((x) => d.disabled.has(x));
  }
  return patch;
}
