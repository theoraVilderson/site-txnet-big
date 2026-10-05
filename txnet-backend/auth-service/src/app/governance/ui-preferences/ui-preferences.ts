import { z } from 'zod';

/**
 * A person's display preferences (UX-1-k, `panel-web/contract.ux.md` P1–P3):
 * one `user_setting` row per key, category `display`. The keys are owned here,
 * the feature that reads them (governance open question 2026-09-04).
 */

export const UI_MOTION_LEVELS = ['system', 'full', 'reduced'] as const;

const id = z.string().min(1).max(40);

export const UI_PREFERENCE_SCHEMAS = {
  'ui.motion': z.enum(UI_MOTION_LEVELS),
  'ui.dashboard': z.object({ order: z.array(id).max(30), hidden: z.array(id).max(30) }).strict(),
  'ui.pins': z.array(z.string().min(1).max(200)).max(8),
  'ui.sidebar': z.object({ collapsed: z.boolean(), closedSections: z.array(id).max(30) }).strict(),
} as const;

export type UiPreferenceKey = keyof typeof UI_PREFERENCE_SCHEMAS;
export type UiPreferences = { [K in UiPreferenceKey]: z.infer<(typeof UI_PREFERENCE_SCHEMAS)[K]> };

export const UI_PREFERENCE_KEYS = Object.keys(UI_PREFERENCE_SCHEMAS) as UiPreferenceKey[];

export const UI_PREFERENCE_DEFAULTS: UiPreferences = {
  'ui.motion': 'system',
  'ui.dashboard': { order: [], hidden: [] },
  'ui.pins': [],
  'ui.sidebar': { collapsed: false, closedSections: [] },
};

/** P2: a value whose JSON is longer than this is refused, whatever its counts. */
export const UI_PREFERENCE_MAX_BYTES = 4096;

export type UiPreferenceRejection = 'unknown_preference' | 'invalid_preference' | 'preference_too_large';

export type UiPreferencePatchResult =
  | { ok: true; patch: Partial<UiPreferences> }
  | { ok: false; reason: UiPreferenceRejection; key?: string };

function isKey(key: string): key is UiPreferenceKey {
  return Object.prototype.hasOwnProperty.call(UI_PREFERENCE_SCHEMAS, key);
}

/** P3: any subset, each value strict; an unknown key is named as such before any value is looked at. */
export function parseUiPreferencesPatch(body: unknown): UiPreferencePatchResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'invalid_preference' };
  const entries = Object.entries(body as Record<string, unknown>);
  const unknown = entries.find(([key]) => !isKey(key));
  if (unknown) return { ok: false, reason: 'unknown_preference', key: unknown[0] };

  const patch: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const parsed = UI_PREFERENCE_SCHEMAS[key as UiPreferenceKey].safeParse(value);
    if (!parsed.success) return { ok: false, reason: 'invalid_preference', key };
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > UI_PREFERENCE_MAX_BYTES) {
      return { ok: false, reason: 'preference_too_large', key };
    }
    patch[key] = parsed.data;
  }
  return { ok: true, patch: patch as Partial<UiPreferences> };
}

/** Stored rows over the defaults; a row that no longer fits its key's schema reads as the default. */
export function readUiPreferences(rows: Array<{ key: string; value: unknown }>): UiPreferences {
  const out: Record<string, unknown> = { ...UI_PREFERENCE_DEFAULTS };
  for (const { key, value } of rows) {
    if (!isKey(key)) continue;
    const parsed = UI_PREFERENCE_SCHEMAS[key].safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as UiPreferences;
}
