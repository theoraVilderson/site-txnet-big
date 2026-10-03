import { AiActionType } from '@prisma/client';

/**
 * F-1550 — what a tenant's AI does when nobody has configured it (ADR-0109
 * point 12, user 2026-10-02). The package decides, not a switch:
 *
 * - `ai_recommendation` in the tenant's package -> the engine runs, every v1
 *   action type on, on templates. No setting row is needed.
 * - no `ai_recommendation` -> no engine run at all, whatever `ai.setting` says.
 * - a tenant that may not sell (F-038-x: suspended, terminated, onboarding)
 *   -> no run either, entitled or not.
 * - the language layer is off until the tenant adds a provider; then model
 *   text is draft-with-approval per type unless the tenant made it automatic
 *   (F-1543).
 *
 * Pure, so the rule is the thing under test (`ai-defaults.spec.ts`).
 */

/** ADR-0109 point 3, without the "later" rows still to build (F-038-t, F-038-v); `wheel_invite` is F-038-u's — it runs only where a wheel does. */
export const AI_V1_ACTION_TYPES: readonly AiActionType[] = [
  AiActionType.renew,
  AiActionType.resize_up,
  AiActionType.resize_down,
  AiActionType.top_up_wallet,
  AiActionType.retain_offer,
  AiActionType.trial_convert,
  AiActionType.checkout_help,
  AiActionType.win_back,
  AiActionType.usage_alert,
  AiActionType.wheel_invite,
];

/** The schema's defaults (`ai.setting`), for a tenant with no row. */
export const AI_SETTING_DEFAULTS = {
  engineEnabled: true,
  disabledActionTypes: [] as AiActionType[],
  automaticActionTypes: [] as AiActionType[],
  confidenceThreshold: 0.6,
  holdoutPercent: 10,
};

export type AiSettingInput = typeof AI_SETTING_DEFAULTS;

export type ModelTextMode = 'draft_with_approval' | 'automatic';

export interface AiTenantMode {
  engineRuns: boolean;
  /** The types the engine may suggest; empty when it does not run. */
  actionTypes: AiActionType[];
  languageLayer: 'on' | 'off';
  /** Per enabled type, how model text goes out; empty while the language layer is off. */
  modelText: Partial<Record<AiActionType, ModelTextMode>>;
  confidenceThreshold: number;
  holdoutPercent: number;
}

export function resolveAiMode(input: {
  entitled: boolean;
  setting: AiSettingInput | null;
  hasActiveProvider: boolean;
  /** F-038-x: `TenantStatusPolicy` lets the tenant sell (not suspended, terminated or onboarding). */
  sells: boolean;
}): AiTenantMode {
  const setting = input.setting ?? AI_SETTING_DEFAULTS;
  const engineRuns = input.entitled && input.sells && setting.engineEnabled;
  const actionTypes = engineRuns
    ? AI_V1_ACTION_TYPES.filter((type) => !setting.disabledActionTypes.includes(type))
    : [];
  const languageLayer = engineRuns && input.hasActiveProvider ? 'on' : 'off';
  const modelText: AiTenantMode['modelText'] = {};
  if (languageLayer === 'on') {
    for (const type of actionTypes) {
      modelText[type] = setting.automaticActionTypes.includes(type) ? 'automatic' : 'draft_with_approval';
    }
  }
  return {
    engineRuns,
    actionTypes,
    languageLayer,
    modelText,
    confidenceThreshold: setting.confidenceThreshold,
    holdoutPercent: setting.holdoutPercent,
  };
}
