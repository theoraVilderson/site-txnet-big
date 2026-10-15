import { CARD_TO_CARD } from './kinds/card-to-card';
import { CRYPTO_WALLET } from './kinds/crypto-wallet';
import type { DestinationField, DestinationFields, FieldRefusal, FieldValue, ManualField, ManualMethod } from './manual-method';

/**
 * Every manual method kind, and the one way their fields are read (F-803-b).
 * A new kind is its file under `kinds/` and one line here (principle 2);
 * nothing outside this file asks which kind it holds.
 */
const KINDS: readonly ManualMethod[] = [CARD_TO_CARD, CRYPTO_WALLET];

const BY_KIND: ReadonlyMap<string, ManualMethod> = new Map(KINDS.map((m) => [m.kind, m]));

/** The method a `manual_gateway_setting.kind` names, or undefined for a kind no longer registered. */
export function manualMethod(kind: string): ManualMethod | undefined {
  return BY_KIND.get(kind);
}

export type FieldRefused = { field: string; reason: FieldRefusal };
export type FieldsParse = { ok: true; fields: DestinationFields } | { ok: false; refusals: FieldRefused[] };

/** Nothing typed: absent, null or blank — an optional field left empty is not stored. */
const isBlank = (raw: unknown) => raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');

const isRecord = (input: unknown): input is Record<string, unknown> => typeof input === 'object' && input !== null && !Array.isArray(input);

/**
 * Checks `input` against `declared` in their order, then names every key no
 * field declares. `isRequired` says whether a blank field is refused; a
 * destination field's `fallback` fills one first.
 */
function parseFields(declared: readonly (ManualField & Partial<Pick<DestinationField, 'fallback'>>)[], input: unknown, isRequired: (f: ManualField) => boolean): FieldsParse {
  if (!isRecord(input)) return { ok: false, refusals: [{ field: '', reason: 'invalid' }] };
  const fields: Record<string, FieldValue> = {};
  const refusals: FieldRefused[] = [];
  for (const f of declared) {
    const raw = input[f.id];
    if (isBlank(raw)) {
      if (f.fallback) fields[f.id] = f.fallback(fields);
      else if (isRequired(f)) refusals.push({ field: f.id, reason: 'missing' });
      continue;
    }
    const checked = f.check(raw);
    if ('value' in checked) fields[f.id] = checked.value;
    else refusals.push({ field: f.id, reason: checked.refused });
  }
  const known = new Set(declared.map((f) => f.id));
  for (const key of Object.keys(input)) if (!known.has(key)) refusals.push({ field: key, reason: 'unknown_field' });
  return refusals.length === 0 ? { ok: true, fields } : { ok: false, refusals };
}

/** A seller's destination fields, each checked by its kind; every refused field is named. */
export function parseDestination(method: ManualMethod, input: unknown): FieldsParse {
  return parseFields(method.destinationFields, input, (f) => !f.optional);
}

/** What the payer is shown: the public fields only (the payment's snapshot, F-803-d). */
export function publicDestination(method: ManualMethod, fields: DestinationFields): DestinationFields {
  const shown = new Set(method.destinationFields.filter((f) => f.public).map((f) => f.id));
  return Object.fromEntries(Object.entries(fields).filter(([id]) => shown.has(id)));
}

// codeshape: spec-only — its caller is the proof route (F-805-a)
/** A payer's proof: every `required` field present, every given field one the kind declares (F-805-a). */
export function parseProof(method: ManualMethod, input: unknown, required: readonly string[]): FieldsParse {
  return parseFields(method.proofFields, input, (f) => required.includes(f.id));
}
