import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { PersonRestrictions, RestrictionKeyView, RestrictionWriteBody, UserRestriction } from "@/lib/auth-api";
import { instantOf, wallTimeOf, type WallTime } from "../../_lib/datetime";
import { reasonOk } from "./person-keys";

const K = FrontendI18nKeys.common.personRestrictions;

/** The dialog's state: a count as typed, a set's picked options, why, and an optional end in wall time. */
export type RestrictionDraft = { key: string; count: string; options: string[]; reason: string; expiresAt: WallTime | null };

/** A fresh draft for `key`, or a change starting from the restriction that holds now. */
export function draftOf(key: RestrictionKeyView, current?: UserRestriction): RestrictionDraft {
  const value = current?.value;
  return {
    key: key.key,
    count: typeof value === "number" ? String(value) : "",
    options: Array.isArray(value) ? [...value] : [],
    reason: current?.reason ?? "",
    expiresAt: wallTimeOf(current?.expiresAt ?? null),
  };
}

/** The count typed, when it is a whole number from 0 to the key's `max` — what `restrictionValueOf` takes. */
function countOf(draft: RestrictionDraft, key: RestrictionKeyView & { kind: "count" }): number | null {
  const text = draft.count.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n <= key.max ? n : null;
}

/** The draft's value in the key's kind, or null where the route would answer `restriction_value_invalid`. */
function valueOf(draft: RestrictionDraft, key: RestrictionKeyView): RestrictionWriteBody["value"] | null {
  if (key.kind === "count") return countOf(draft, key);
  const picked = key.options.filter((o) => draft.options.includes(o));
  return picked.length > 0 ? picked.sort() : null;
}

/** Save is offered only for what the route takes: a valid value, a reason of 3-500, an end still ahead (`expiry_past`). */
export function restrictionDraftOk(draft: RestrictionDraft, key: RestrictionKeyView, now: number = Date.now()): boolean {
  if (valueOf(draft, key) === null || !reasonOk(draft.reason)) return false;
  return !draft.expiresAt || new Date(instantOf(draft.expiresAt)).getTime() > now;
}

/** The `PUT …/restrictions/:key` body; call only once {@link restrictionDraftOk} holds. */
export function restrictionWriteBody(draft: RestrictionDraft, key: RestrictionKeyView): RestrictionWriteBody {
  const value = valueOf(draft, key);
  if (value === null) throw new Error(`restriction draft for ${key.key} has no valid value`);
  return { value, reason: draft.reason.trim(), expiresAt: draft.expiresAt ? instantOf(draft.expiresAt) : null };
}

/** The keys "add" may offer: those not set on the person — a set one is changed from its own row. */
export function unsetKeys(view: PersonRestrictions): RestrictionKeyView[] {
  const set = new Set(view.restrictions.map((r) => r.key));
  return view.keys.filter((k) => !set.has(k.key));
}

/**
 * The reasons a restriction write is refused with beyond the door's
 * (`UserRestrictionsRejection`). The spec reads the service's union, so a
 * new reason ships with its sentence.
 */
export type RestrictionRefusal = keyof typeof K.refusals;

export const RESTRICTION_REFUSAL_KEYS: Record<RestrictionRefusal, string> = K.refusals;

export function restrictionRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in RESTRICTION_REFUSAL_KEYS ? RESTRICTION_REFUSAL_KEYS[reason as RestrictionRefusal] : null;
}
