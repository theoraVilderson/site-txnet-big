import { ApiError } from "@/lib/api-error";
import { DESTINATION_WEIGHT, type DestinationBody, type ManualDestination } from "@/lib/billing-api";
import type { DestinationDraft, DestinationErrors, FieldRefusal, TransferKind } from "../../_components/transfer/transfer-kind";

/**
 * One card or wallet as the seller's editor holds it (F-803-g): every value a
 * string, as typed. Conversion happens once, in {@link destinationBody}; the
 * kind's own fields are checked by the kind (`TransferKind.check`) and again,
 * finally, by billing (`invalid_destination`).
 */
export interface DestinationForm {
  label: string;
  fields: DestinationDraft;
  isActive: boolean;
  /** F-807's rotation, stored and unread until then — under "advanced". */
  weight: string;
  /** Minor units of the charge currency; empty is no cap. */
  dailyCapMinor: string;
}

export interface DestinationFormErrors {
  label?: "required";
  weight?: "invalid";
  dailyCapMinor?: "invalid";
  fields: DestinationErrors;
}

/** Billing's `invalid_destination`: one refused field per fact. */
const INVALID_DESTINATION = "invalid_destination";
const REFUSALS: readonly FieldRefusal[] = ["missing", "invalid", "checksum", "unknown_field"];
const WHOLE = /^\d{1,3}$/;
/** Billing's `dailyCapMinor` shape: a positive integer of at most 18 digits. */
const CAP = /^[1-9]\d{0,17}$/;

/** The fields a destination of this kind sends — the kind's own, or, for a kind the panel cannot draw, whatever is stored. */
function sentFieldIds(kind: TransferKind, draft: DestinationDraft): string[] {
  return kind.destinationFields.length > 0 ? kind.destinationFields.map((f) => f.id) : Object.keys(draft);
}

export function emptyDestinationForm(kind: TransferKind): DestinationForm {
  return {
    label: "",
    fields: Object.fromEntries(kind.destinationFields.map((f) => [f.id, ""])),
    isActive: true,
    weight: String(DESTINATION_WEIGHT.default),
    dailyCapMinor: "",
  };
}

/**
 * A stored destination as the editor edits it. Only the fields the kind sends
 * are carried — a card's `bankId` is derived by billing from the number, so
 * keeping the stored one would pin a bank the new number does not belong to.
 */
export function destinationFormOf(d: ManualDestination, kind: TransferKind): DestinationForm {
  const stored = Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, String(v)]));
  const ids = sentFieldIds(kind, stored);
  return {
    label: d.label,
    fields: Object.fromEntries(ids.map((id) => [id, stored[id] ?? ""])),
    isActive: d.isActive,
    weight: String(d.weight),
    dailyCapMinor: d.dailyCapMinor ?? "",
  };
}

/** What the client can tell before a request. Billing still decides. */
export function destinationErrors(form: DestinationForm, kind: TransferKind): DestinationFormErrors {
  const errors: DestinationFormErrors = { fields: kind.check(form.fields) };
  if (!form.label.trim()) errors.label = "required";
  const weight = form.weight.trim();
  if (!WHOLE.test(weight) || Number(weight) < DESTINATION_WEIGHT.min || Number(weight) > DESTINATION_WEIGHT.max) errors.weight = "invalid";
  if (form.dailyCapMinor.trim() && !CAP.test(form.dailyCapMinor.trim())) errors.dailyCapMinor = "invalid";
  return errors;
}

export const hasDestinationErrors = (e: DestinationFormErrors) =>
  Boolean(e.label || e.weight || e.dailyCapMinor) || Object.values(e.fields).some(Boolean);

/** The create / update body: the kind's fields that are filled, trimmed; a blank optional one is left out. */
export function destinationBody(form: DestinationForm, kind: TransferKind): DestinationBody & { label: string; fields: ManualDestination["fields"] } {
  const fields: ManualDestination["fields"] = {};
  for (const id of sentFieldIds(kind, form.fields)) {
    const v = (form.fields[id] ?? "").trim();
    if (v) fields[id] = v;
  }
  return {
    label: form.label.trim(),
    fields,
    isActive: form.isActive,
    weight: Number(form.weight.trim()),
    dailyCapMinor: form.dailyCapMinor.trim() || null,
  };
}

/** Billing's per-field refusals of a destination, or `null` when the failure was something else. */
export function refusalsOf(e: unknown): DestinationErrors | null {
  if (!(e instanceof ApiError) || e.reason !== INVALID_DESTINATION) return null;
  const out: DestinationErrors = {};
  for (const [field, reason] of Object.entries(e.facts)) {
    if (REFUSALS.includes(reason as FieldRefusal)) out[field] = reason as FieldRefusal;
  }
  return out;
}
