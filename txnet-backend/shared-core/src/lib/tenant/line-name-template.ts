/**
 * A reseller's line-name template (F-307-j, ADR-0089 rule 4): the default name
 * a VPN app shows for a config line its buyer has not named, e.g.
 * `{brand} · {region}`. It lives in the reseller's branding and is evaluated
 * each time a line is served, so a change reaches every config at once.
 *
 * Evaluated in two languages: billing's config list (TypeScript, through
 * this file) and `/sub` (Go, `sub-service/internal/sub/line_names.go`). Both
 * are held to `contracts/network/line-names.json`; a change here is a change
 * there.
 */

/** The default name when a reseller has set none: the panel's region, e.g. `آلمان`. */
export const PLATFORM_LINE_NAME_TEMPLATE = '{region}';

/** What a template may name. Numbering (` 2`, ` 3`) is automatic, never a placeholder. */
export const LINE_NAME_PLACEHOLDERS = ['brand', 'region'] as const;
export type LineNamePlaceholder = (typeof LINE_NAME_PLACEHOLDERS)[number];

/** The longest template, as a buyer's label (CHECK `tenant_branding_line_name_template_shape`). */
export const MAX_LINE_NAME_TEMPLATE_LENGTH = 40;

/** Why a template is refused; the panel says each in its own sentence. */
export const LINE_NAME_TEMPLATE_PROBLEMS = ['too_long', 'unknown_placeholder', 'control_character'] as const;
export type LineNameTemplateProblem = (typeof LINE_NAME_TEMPLATE_PROBLEMS)[number];

const PLACEHOLDER = /\{(brand|region)\}/g;
/** C0/C1 controls and bidi overrides: a name must not re-order the app's list around it. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** A template as stored: trimmed, and an empty one is `null`, the platform's. */
export function normalizeLineNameTemplate(template: string | null | undefined): string | null {
  const t = (template ?? '').trim();
  return t === '' ? null : t;
}

/** Why `template` (already normalized) cannot be stored, or `null` when it can. */
export function lineNameTemplateProblem(template: string | null): LineNameTemplateProblem | null {
  if (template === null) return null;
  if ([...template].length > MAX_LINE_NAME_TEMPLATE_LENGTH) return 'too_long';
  if (CONTROL.test(template)) return 'control_character';
  if (/[{}]/.test(template.replace(PLACEHOLDER, ''))) return 'unknown_placeholder';
  return null;
}

/**
 * A line's base name from a template: each placeholder replaced once, in one
 * pass (a brand name holding `{region}` stays as written), then trimmed. An
 * empty result is the panel's own name, the caller's to keep.
 */
export function evaluateLineNameTemplate(
  template: string | null,
  values: Readonly<Record<LineNamePlaceholder, string>>,
): string {
  return (template ?? PLATFORM_LINE_NAME_TEMPLATE).replace(PLACEHOLDER, (_m, k: LineNamePlaceholder) => values[k]).trim();
}
