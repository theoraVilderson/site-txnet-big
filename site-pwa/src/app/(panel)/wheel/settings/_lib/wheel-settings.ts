import type { Me } from "@/lib/auth-api";
import { WHEEL_PRIZE_TYPES, type WheelPrizeType, type WheelVersion, type WheelVersionBody } from "@/lib/engagement-api";
import { holdsPermission } from "@/lib/permissions";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The page's strings as generated constants (C-06). */
export const WHEEL_SETTINGS_KEYS = FrontendI18nKeys.common.wheelSettings;
const K = WHEEL_SETTINGS_KEYS;
type Key = string;

/** The key `EngagementPermissionGuard` gates on; the spec reads it from the guard. */
export const WHEEL_MANAGE = "engagement.manage";
export const canManageWheel = (me: Me | null) => holdsPermission(me?.permissions, WHEEL_MANAGE);

/** `wheelVersionSchema`'s bounds; the spec reads them from the schema. */
export const PRIZES_MIN = 2;
export const PRIZES_MAX = 16;
export const PRIZE_LABEL_MAX = 40;

/**
 * Every reason billing refuses this page with: `WheelAdminRejection` and the
 * report's `WheelReportRejection`. The spec reads both unions, so a new reason
 * does not ship without its sentence.
 */
export type WheelSettingsRefusal =
  | "invalid_prize"
  | "invalid_amount"
  | "expected_cost_over_cap"
  | "prize_cost_over_cap"
  | "coupon_template_not_found"
  | "variant_not_found"
  | "group_not_found"
  | "version_not_found"
  | "version_taken"
  | "invalid_range";

export const REFUSAL_KEYS: Record<WheelSettingsRefusal, string> = K.refusals;

export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as WheelSettingsRefusal] : null;
}

/** The kinds an admin may pick — billing's, never `wallet_credit` (ADR-0111 point 2). */
export const PRIZE_TYPES: readonly WheelPrizeType[] = WHEEL_PRIZE_TYPES;
export const PRIZE_TYPE_KEYS: Record<WheelPrizeType, string> = K.prizeTypes;

// ------------------------------------------------------------- money, exactly

/** billing's `DECIMAL`: no sign, no leading zero, at most two places. */
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const WHOLE = /^(0|[1-9]\d{0,8})$/;

/** A decimal string as whole cents, or `null` when billing would refuse it. Never a float (C-02). */
function cents(v: string): bigint | null {
  const s = v.trim();
  if (!DECIMAL.test(s)) return null;
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
}

function whole(v: string): number | null {
  const s = v.trim();
  return WHOLE.test(s) ? Number(s) : null;
}

const fromCents = (c: bigint) => `${c / BigInt(100)}.${(c % BigInt(100)).toString().padStart(2, "0")}`;

/** `n / d` to two places, half up; both positive. */
const divided = (n: bigint, d: bigint) => (BigInt(2) * n + d) / (BigInt(2) * d);

/** Each slot's chance as a percent to two places, as the user's wheel shows it; `null` while a weight is unreadable. */
export function oddsPercents(weights: readonly string[]): string[] | null {
  const ws = weights.map(whole);
  if (ws.some((w) => w === null || w < 1)) return null;
  const total = BigInt(ws.reduce((s: number, w) => s + (w as number), 0));
  return ws.map((w) => fromCents(divided(BigInt(w as number) * BigInt(10_000), total)));
}

/** Σ weight × cost / Σ weight to the cent, half up: billing's `expectedCostPerSpin`. `null` while a figure is unreadable. */
export function expectedCostPerSpin(prizes: ReadonlyArray<{ weight: string; costAmount: string }>): string | null {
  const sums = costSums(prizes);
  return sums && fromCents(divided(sums.weighted, sums.total));
}

function costSums(prizes: ReadonlyArray<{ weight: string; costAmount: string }>): { weighted: bigint; total: bigint } | null {
  let weighted = BigInt(0);
  let total = BigInt(0);
  for (const p of prizes) {
    const w = whole(p.weight);
    const c = cents(p.costAmount);
    if (w === null || w < 1 || c === null) return null;
    weighted += BigInt(w) * c;
    total += BigInt(w);
  }
  return total > BigInt(0) ? { weighted, total } : null;
}

/** How many average spins the cap pays for in a day; `null` when a spin costs nothing on average. */
export function capLastsSpins(cap: string, expected: string): number | null {
  const c = cents(cap);
  const e = cents(expected);
  if (c === null || e === null || e === BigInt(0)) return null;
  return Number(c / e);
}

// -------------------------------------------------------------------- the form

/** One slot as the form holds it: every field a string, as typed. */
export interface PrizeForm {
  label: string;
  prizeType: WheelPrizeType;
  prizeValue: string;
  couponTemplateId: string;
  couponValidDays: string;
  variantId: string;
  weight: string;
  costAmount: string;
  /** Blank = no stock limit. */
  dailyStockLimit: string;
}

export interface WheelForm {
  isActive: boolean;
  cap: string;
  cooldownHours: string;
  maxSpins: string;
  minAgeHours: string;
  /** Blank = no minimum. */
  minPaid: string;
  minOrders: string;
  activeService: boolean;
  phoneVerified: boolean;
  /** Blank = every user. */
  userGroupId: string;
  prizes: PrizeForm[];
}

export const emptyPrize = (): PrizeForm => ({
  label: "",
  prizeType: "empty",
  prizeValue: "0",
  couponTemplateId: "",
  couponValidDays: "",
  variantId: "",
  weight: "1",
  costAmount: "0",
  dailyStockLimit: "",
});

/** A first wheel: billing's defaults, and the two slots the schema asks for. */
export const emptyWheelForm = (): WheelForm => ({
  isActive: true,
  cap: "",
  cooldownHours: "0",
  maxSpins: "1",
  minAgeHours: "24",
  minPaid: "",
  minOrders: "",
  activeService: true,
  phoneVerified: true,
  userGroupId: "",
  prizes: [emptyPrize(), emptyPrize()],
});

const text = (v: number | string | null) => (v === null ? "" : String(v));

/** The form opened on a saved version: a save that changes one thing restates the rest. */
export function formFromVersion(v: WheelVersion): WheelForm {
  return {
    isActive: v.isActive,
    cap: v.dailyBudgetCapAmount,
    cooldownHours: text(v.perUserCooldownHours),
    maxSpins: text(v.maxSpinsPerAccountPerDay),
    minAgeHours: text(v.requiresMinAccountAgeHours),
    minPaid: text(v.requiresMinTotalPurchaseAmount),
    minOrders: text(v.requiresMinCompletedOrdersCount),
    activeService: v.requiresActiveServiceAtSpinTime,
    phoneVerified: v.requiresPhoneVerified,
    userGroupId: v.userGroupId ?? "",
    prizes: [...v.prizes]
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        label: p.label,
        prizeType: p.prizeType,
        prizeValue: p.prizeValue,
        couponTemplateId: p.couponTemplateId ?? "",
        couponValidDays: text(p.couponValidDays),
        variantId: p.variantId ?? "",
        weight: text(p.weight),
        costAmount: p.costAmount,
        dailyStockLimit: text(p.dailyStockLimit),
      })),
  };
}

type Errors<T> = Partial<Record<keyof T, Key>>;
type WheelFields = Omit<WheelForm, "prizes" | "isActive" | "activeService" | "phoneVerified">;

export interface WheelFormCheck {
  ok: boolean;
  fields: Errors<WheelFields>;
  prizes: Array<Errors<PrizeForm>>;
  /** A rule over the whole wheel: too few or many slots, the average over the cap. */
  overall: Key | null;
}

/** Whole numbers within billing's schema bounds; blank is allowed only where `optional`. */
function inRange(v: string, min: number, max: number, optional = false): boolean {
  if (optional && v.trim() === "") return true;
  const n = whole(v);
  return n !== null && n >= min && n <= max;
}

/** Each kind's own fields, the shape billing's `checkPrize` and the database hold. */
function checkPrize(p: PrizeForm, cap: bigint | null): Errors<PrizeForm> {
  const e: Errors<PrizeForm> = {};
  const label = p.label.trim();
  if (!label) e.label = K.errors.labelRequired;
  else if (label.length > PRIZE_LABEL_MAX) e.label = K.errors.labelTooLong;
  if (!inRange(p.weight, 1, 1_000_000)) e.weight = K.errors.weight;
  if (!inRange(p.dailyStockLimit, 0, 1_000_000, true)) e.dailyStockLimit = K.errors.wholeNumber;

  const cost = cents(p.costAmount);
  if (cost === null) e.costAmount = K.errors.amount;
  else if (p.prizeType === "empty" && cost !== BigInt(0)) e.costAmount = K.errors.emptyCostsNothing;
  else if (cap !== null && cost > cap) e.costAmount = K.errors.prizeOverCap;

  const value = cents(p.prizeValue);
  switch (p.prizeType) {
    case "bonus_traffic_gb":
      if (value === null || value <= BigInt(0)) e.prizeValue = K.errors.positive;
      break;
    case "extra_days":
      if (value === null || value < BigInt(100) || value % BigInt(100) !== BigInt(0)) e.prizeValue = K.errors.wholeDays;
      break;
    case "discount_coupon":
      if (value === null || value <= BigInt(0) || value > BigInt(10_000)) e.prizeValue = K.errors.percent;
      if (!p.couponTemplateId.trim()) e.couponTemplateId = K.errors.templateRequired;
      if (!inRange(p.couponValidDays, 1, 365)) e.couponValidDays = K.errors.validDays;
      break;
    case "free_grant":
      if (!p.variantId.trim()) e.variantId = K.errors.variantRequired;
      break;
    case "empty":
      if (value !== BigInt(0)) e.prizeValue = K.errors.emptyIsNothing;
      break;
  }
  return e;
}

/**
 * The rules billing would refuse a save on, before the call: the slots, each
 * prize's shape, the cap. Billing checks all of it again; this keeps a sure
 * refusal off the wire and says which field.
 */
export function validateWheelForm(form: WheelForm): WheelFormCheck {
  const fields: Errors<WheelFields> = {};
  const cap = cents(form.cap);
  if (cap === null) fields.cap = K.errors.amount;
  if (!inRange(form.cooldownHours, 0, 24 * 30)) fields.cooldownHours = K.errors.wholeNumber;
  if (!inRange(form.maxSpins, 1, 24)) fields.maxSpins = K.errors.maxSpins;
  if (!inRange(form.minAgeHours, 0, 24 * 365)) fields.minAgeHours = K.errors.wholeNumber;
  if (form.minPaid.trim() !== "" && cents(form.minPaid) === null) fields.minPaid = K.errors.amount;
  if (!inRange(form.minOrders, 0, 10_000, true)) fields.minOrders = K.errors.wholeNumber;

  const prizes = form.prizes.map((p) => checkPrize(p, cap));
  let overall: Key | null = null;
  if (form.prizes.length < PRIZES_MIN) overall = K.errors.tooFewPrizes;
  else if (form.prizes.length > PRIZES_MAX) overall = K.errors.tooManyPrizes;
  else {
    const sums = costSums(form.prizes);
    // Exactly billing's comparison: Σ w·c / Σ w > cap, without dividing.
    if (sums && cap !== null && sums.weighted > cap * sums.total) overall = K.errors.expectedOverCap;
  }
  const ok = overall === null && Object.keys(fields).length === 0 && prizes.every((p) => Object.keys(p).length === 0);
  return { ok, fields, prizes, overall };
}

const nullable = (v: string) => (v.trim() === "" ? null : v.trim());
const count = (v: string) => (v.trim() === "" ? null : Number(v.trim()));

/**
 * The `.strict()` body, prizes in slot order. A prize carries its kind's
 * fields and nulls for the rest, so a kind changed in the form does not send
 * the old kind's template or variant. Call after {@link validateWheelForm}.
 */
export function wheelVersionBody(form: WheelForm): WheelVersionBody {
  return {
    isActive: form.isActive,
    dailyBudgetCapAmount: form.cap.trim(),
    perUserCooldownHours: Number(form.cooldownHours.trim()),
    maxSpinsPerAccountPerDay: Number(form.maxSpins.trim()),
    requiresMinAccountAgeHours: Number(form.minAgeHours.trim()),
    requiresMinTotalPurchaseAmount: nullable(form.minPaid),
    requiresMinCompletedOrdersCount: count(form.minOrders),
    requiresActiveServiceAtSpinTime: form.activeService,
    requiresPhoneVerified: form.phoneVerified,
    userGroupId: nullable(form.userGroupId),
    prizes: form.prizes.map((p) => {
      const coupon = p.prizeType === "discount_coupon";
      return {
        label: p.label.trim(),
        prizeType: p.prizeType,
        prizeValue: p.prizeType === "free_grant" || p.prizeType === "empty" ? "0" : p.prizeValue.trim(),
        couponTemplateId: coupon ? nullable(p.couponTemplateId) : null,
        couponValidDays: coupon ? count(p.couponValidDays) : null,
        variantId: p.prizeType === "free_grant" ? nullable(p.variantId) : null,
        weight: Number(p.weight.trim()),
        costAmount: p.costAmount.trim(),
        dailyStockLimit: count(p.dailyStockLimit),
      };
    }),
  };
}
