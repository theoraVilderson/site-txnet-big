import type { CreateDiscountRuleBody, DiscountRule, DiscountRuleRejection, DiscountRuleStatus, UpdateDiscountRuleBody } from "@/lib/billing-api";
import { COUPON_KEYS, dayToInstant, instantToDay } from "./coupon-form";

/**
 * Tab 3 of the coupons page — discounts with no code (F-114-k, ADR-0087).
 *
 * Billing holds every rule (`discount-rule-admin.service.ts`,
 * `billing/contract.purchase.md` "Discounts with no code"); this file only
 * keeps the form from sending what billing would refuse, and an edit from
 * restating what nobody touched.
 */

/** Every string the tab can show (C-06). */
export const RULE_KEYS = COUPON_KEYS.rules;
const E = RULE_KEYS.errors;

/** The schema's bounds; the spec reads both from `discount-rule.schema.ts`. */
export const RULE_NAME_MAX = 80;
export const RULE_USERS_MAX = 1000;

/**
 * One sentence per reason billing refuses with. A `Record` over the union, so
 * a reason added there does not compile here; the spec reads the service's own
 * union to catch the case where both sides forgot.
 */
export const RULE_REFUSAL_KEYS: Record<DiscountRuleRejection, string> = RULE_KEYS.refusals;

/** The refusal's own sentence key, when billing named one this tab knows. */
export function ruleRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in RULE_REFUSAL_KEYS ? RULE_REFUSAL_KEYS[reason as DiscountRuleRejection] : null;
}

/** Theme tokens per status — green while it runs, never gold. */
export const RULE_STATUS_TONES: Record<DiscountRuleStatus, string> = {
  running: "bg-primary/10 text-primary",
  scheduled: "bg-[var(--leaf-bg)] text-text-primary",
  off: "bg-[var(--leaf-bg)] text-text-secondary",
  ended: "bg-error/10 text-error",
};

export type RuleTarget = "all" | "product" | "category";
export type RuleAudience = "everyone" | "named" | "group";

/** The form as typed: every box a string, so nothing is converted until it is sent. */
export interface RuleForm {
  name: string;
  kind: DiscountRule["kind"];
  value: string;
  target: RuleTarget;
  productId: string;
  categoryId: string;
  audience: RuleAudience;
  /** One uuid per line, space or comma — the user search appends here. */
  userIds: string;
  groupId: string;
  /** `YYYY-MM-DD`, Tehran's day, as the coupon form's (`dayToInstant`). */
  startsAt: string;
  /** Inclusive as picked; sent as the next day's first instant, which billing reads as exclusive. `""` = no end. */
  endsAt: string;
  isActive: boolean;
}

export type RuleFormErrors = Partial<Record<keyof RuleForm, string>>;

/** Today in Tehran — a new rule starts now unless a day is picked. */
export const tehranToday = (now = Date.now()) => instantToDay(new Date(now).toISOString(), "start");

export function emptyRuleForm(now = Date.now()): RuleForm {
  return {
    name: "",
    kind: "percentage",
    value: "",
    target: "all",
    productId: "",
    categoryId: "",
    audience: "everyone",
    userIds: "",
    groupId: "",
    startsAt: tehranToday(now),
    endsAt: "",
    isActive: true,
  };
}

export function formFromRule(r: DiscountRule): RuleForm {
  return {
    name: r.name,
    kind: r.kind,
    value: r.value,
    target: r.productId ? "product" : r.categoryId ? "category" : "all",
    productId: r.productId ?? "",
    categoryId: r.categoryId ?? "",
    audience: r.forNamedUsers ? "named" : r.groupId ? "group" : "everyone",
    userIds: r.userIds.join("\n"),
    groupId: r.groupId ?? "",
    startsAt: instantToDay(r.startsAt, "start"),
    endsAt: instantToDay(r.endsAt, "end"),
    isActive: r.isActive,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** billing's `DECIMAL`: up to 16 whole digits and 2 decimals, no sign. */
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

/** The ids typed or picked, de-duplicated, in order. */
export const idsOf = (text: string) => [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

/** The form's rules — billing's `checkShape` and schema, answered before the round trip. */
export function validateRuleForm(f: RuleForm): RuleFormErrors {
  const out: RuleFormErrors = {};
  const put = (k: keyof RuleForm, key: string) => (out[k] ??= key);

  const name = f.name.trim();
  if (!name) put("name", E.required);
  else if (name.length > RULE_NAME_MAX) put("name", E.nameTooLong);

  const value = f.value.trim();
  if (!DECIMAL.test(value) || Number(value) <= 0) put("value", E.value);
  else if (f.kind === "percentage" && Number(value) > 100) put("value", E.percent);

  if (f.target === "product" && !UUID.test(f.productId.trim())) put("productId", E.pickProduct);
  if (f.target === "category" && !UUID.test(f.categoryId.trim())) put("categoryId", E.pickCategory);

  if (f.audience === "named") {
    const users = idsOf(f.userIds);
    if (users.length === 0) put("userIds", E.needsUsers);
    else if (users.some((u) => !UUID.test(u))) put("userIds", E.uuid);
    else if (users.length > RULE_USERS_MAX) put("userIds", E.tooManyUsers);
  }
  if (f.audience === "group" && !UUID.test(f.groupId.trim())) put("groupId", E.pickGroup);

  if (!f.startsAt) put("startsAt", E.required);
  else if (f.endsAt && dayToInstant(f.endsAt, "end") <= dayToInstant(f.startsAt, "start")) put("endsAt", E.window);
  return out;
}

/** What each section of the form sends, whole — a section that changed is sent as a unit. */
function sections(f: RuleForm) {
  return {
    target: {
      productId: f.target === "product" ? f.productId.trim() : null,
      categoryId: f.target === "category" ? f.categoryId.trim() : null,
    },
    // `userIds` rides only with named users: with no names billing keeps none anyway.
    audience:
      f.audience === "named"
        ? { forNamedUsers: true, userIds: idsOf(f.userIds), groupId: null }
        : { forNamedUsers: false, groupId: f.audience === "group" ? f.groupId.trim() : null },
    window: {
      startsAt: dayToInstant(f.startsAt, "start"),
      endsAt: f.endsAt ? dayToInstant(f.endsAt, "end") : null,
    },
  };
}

/** Call after {@link validateRuleForm}. Nothing is sent that means "everyone" or "everything" by default. */
export function createRuleBody(f: RuleForm): CreateDiscountRuleBody {
  const s = sections(f);
  return {
    name: f.name.trim(),
    kind: f.kind,
    value: f.value.trim(),
    startsAt: s.window.startsAt,
    ...(s.window.endsAt ? { endsAt: s.window.endsAt } : {}),
    ...(s.target.productId ? { productId: s.target.productId } : {}),
    ...(s.target.categoryId ? { categoryId: s.target.categoryId } : {}),
    ...(s.audience.forNamedUsers ? { forNamedUsers: true, userIds: s.audience.userIds } : {}),
    ...(s.audience.groupId ? { groupId: s.audience.groupId } : {}),
    ...(f.isActive ? {} : { isActive: false }),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Only what changed. The target and the audience go whole when anything in
 * them changed, so a switch from named users to a group clears the names in
 * the same write — billing refuses both at once (`one_audience`). A day left
 * as it was is not re-sent: a rule made through the API may start mid-day,
 * and the form would move it to midnight.
 */
export function updateRuleBody(f: RuleForm, original: DiscountRule): UpdateDiscountRuleBody {
  const was = formFromRule(original);
  const now = sections(f);
  const before = sections(was);
  const body: UpdateDiscountRuleBody = {};
  if (f.name.trim() !== was.name) body.name = f.name.trim();
  if (f.kind !== was.kind) body.kind = f.kind;
  if (f.kind !== was.kind || Number(f.value) !== Number(was.value)) body.value = f.value.trim();
  if (!same(now.target, before.target)) Object.assign(body, now.target);
  if (!same(now.audience, before.audience)) Object.assign(body, now.audience);
  if (f.startsAt !== was.startsAt) body.startsAt = now.window.startsAt;
  if (f.endsAt !== was.endsAt) body.endsAt = now.window.endsAt;
  if (f.isActive !== was.isActive) body.isActive = f.isActive;
  return body;
}
