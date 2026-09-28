import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { Me } from "@/lib/auth-api";
import type {
  AdminCoupon,
  CouponChannel,
  CouponGatewayRef,
  CouponRejection,
  CouponStatus,
  CreateCouponBody,
  RedemptionStatus,
  UpdateCouponBody,
  UsageQuery,
} from "@/lib/billing-api";
import { REDEMPTION_STATUSES } from "@/lib/billing-api";

/** Every string the coupons page can show (C-06). */
export const COUPON_KEYS = FrontendI18nKeys.common.coupons;
const E = COUPON_KEYS.errors;

/** billing's `COUPON_MANAGE` — the menu entry needs it (F-502-a). */
export const COUPON_MANAGE = "coupon.manage";

/**
 * One sentence per reason `CouponAdminService` can refuse with. A `Record` over
 * the union, so a reason added there does not compile here; `coupons.test.ts`
 * reads the service's own union to catch the case where both sides forgot.
 */
export const REFUSAL_KEYS: Record<CouponRejection, string> = {
  not_platform_owner: COUPON_KEYS.refusals.not_platform_owner,
  coupon_not_found: COUPON_KEYS.refusals.coupon_not_found,
  tenant_not_found: COUPON_KEYS.refusals.tenant_not_found,
  code_taken: COUPON_KEYS.refusals.code_taken,
  invalid_code: COUPON_KEYS.refusals.invalid_code,
  invalid_value: COUPON_KEYS.refusals.invalid_value,
  invalid_limit: COUPON_KEYS.refusals.invalid_limit,
  limits_not_for_gift_codes: COUPON_KEYS.refusals.limits_not_for_gift_codes,
  targeted_needs_users: COUPON_KEYS.refusals.targeted_needs_users,
  user_out_of_scope: COUPON_KEYS.refusals.user_out_of_scope,
  platform_coupon_needs_platform_gateway: COUPON_KEYS.refusals.platform_coupon_needs_platform_gateway,
  gateway_not_found: COUPON_KEYS.refusals.gateway_not_found,
  scope_not_found: COUPON_KEYS.refusals.scope_not_found,
  variant_not_found: COUPON_KEYS.refusals.variant_not_found,
  used_coupon_frozen: COUPON_KEYS.refusals.used_coupon_frozen,
  capacity_below_used: COUPON_KEYS.refusals.capacity_below_used,
  batch_not_found: COUPON_KEYS.refusals.batch_not_found,
  invalid_batch: COUPON_KEYS.refusals.invalid_batch,
};

/** The refusal's own sentence key, when billing named one this page knows. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as CouponRejection] : null;
}

/** Theme tokens per status — green for live, error tones for what stopped; never gold. */
export const STATUS_TONES: Record<CouponStatus, string> = {
  active: "bg-primary/10 text-primary",
  scheduled: "bg-[var(--leaf-bg)] text-text-primary",
  inactive: "bg-[var(--leaf-bg)] text-text-secondary",
  exhausted: "bg-error/10 text-error",
  expired: "bg-error/10 text-error",
  deleted: "bg-error/10 text-error",
};

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_KEYS: Record<(typeof WEEKDAYS)[number], string> = {
  1: COUPON_KEYS.form.weekday.mon,
  2: COUPON_KEYS.form.weekday.tue,
  3: COUPON_KEYS.form.weekday.wed,
  4: COUPON_KEYS.form.weekday.thu,
  5: COUPON_KEYS.form.weekday.fri,
  6: COUPON_KEYS.form.weekday.sat,
  7: COUPON_KEYS.form.weekday.sun,
};
export const CHANNELS: readonly CouponChannel[] = ["panel", "bot"];

export type CouponOwnerChoice = "own" | "platform" | "tenant";

/** The form as typed: every box a string, so nothing is converted until it is sent. */
export interface CouponForm {
  /** The platform owner only: whose coupon it is. */
  owner: CouponOwnerChoice;
  tenantId: string;
  code: string;
  discountType: "percentage" | "fixed_amount" | "free_grant";
  discountValue: string;
  /** A free service only: the catalog variant it grants (F-502-l-c). */
  grantVariantId: string;
  maxDiscountCap: string;
  minPurchaseAmount: string;
  maxPurchaseAmount: string;
  totalUsageLimit: string;
  perUserUsageLimit: string;
  /** `YYYY-MM-DD`, Tehran's day (see {@link dayToInstant}). */
  validFrom: string;
  expiresAt: string;
  isActive: boolean;
  visibility: "public" | "targeted";
  /** One uuid per line or comma. */
  allowedUserIds: string;
  activeWeekdays: number[];
  activeHourFrom: string;
  activeHourTo: string;
  firstPurchaseOnly: boolean;
  newUserWithinDays: string;
  periodUsageLimit: string;
  periodDays: string;
  allowedChannels: CouponChannel[];
  /** `source:id` of each gateway it is limited to. */
  gateways: string[];
  productIds: string;
  variantIds: string;
  label: string;
  note: string;
}

export type CouponFormErrors = Partial<Record<keyof CouponForm, string>>;

export function emptyCouponForm(): CouponForm {
  return {
    owner: "own",
    tenantId: "",
    code: "",
    discountType: "percentage",
    discountValue: "",
    grantVariantId: "",
    maxDiscountCap: "",
    minPurchaseAmount: "",
    maxPurchaseAmount: "",
    totalUsageLimit: "",
    perUserUsageLimit: "1",
    validFrom: "",
    expiresAt: "",
    isActive: true,
    visibility: "public",
    allowedUserIds: "",
    activeWeekdays: [],
    activeHourFrom: "",
    activeHourTo: "",
    firstPurchaseOnly: false,
    newUserWithinDays: "",
    periodUsageLimit: "",
    periodDays: "",
    allowedChannels: [],
    gateways: [],
    productIds: "",
    variantIds: "",
    label: "",
    note: "",
  };
}

export const isPlatformOwner = (me: Me | null) => me?.tenant?.type === "platform_owner";

/**
 * Billing froze this coupon's type, value and grant variant. The counters are
 * not the rule — a released redemption leaves none and still freezes it — so
 * the view says it and the form only reads it (F-502-c, F-502-o).
 */
export const isFrozen = (c: Pick<AdminCoupon, "frozen">) => c.frozen;

/** Tehran has kept +03:30 all year since 2022; the coupon's weekday and hour gates read the same clock. */
const TEHRAN_OFFSET = "+03:30";

/**
 * A picked day as the instant billing stores. `start`: that day's first
 * instant in Tehran (`validFrom`). `end`: the next day's first instant, so the
 * coupon works through the whole day picked (`expiresAt`).
 */
export function dayToInstant(day: string, edge: "start" | "end"): string {
  if (edge === "start") return `${day}T00:00:00${TEHRAN_OFFSET}`;
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T00:00:00${TEHRAN_OFFSET}`;
}

/** The usage report's status filter offers billing's redemption statuses (F-502-i). */
export const USAGE_STATUSES = REDEMPTION_STATUSES;

/** The usage report's filters as picked: `""` is no filter; days are Tehran's `YYYY-MM-DD`. */
export interface UsageFilter {
  status: RedemptionStatus | "";
  from: string;
  to: string;
}

export const emptyUsageFilter = (): UsageFilter => ({ status: "", from: "", to: "" });

const USAGE_PAGE_SIZE = 20;

/**
 * The report's query. Billing reads `from` as `gte` and `to` as `lte`, so the
 * "to" day ends on its own last instant — the next midnight would count a
 * redemption made at exactly 00:00 of the day after.
 */
export function usageQuery(f: UsageFilter, page: number): UsageQuery {
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.from ? { from: dayToInstant(f.from, "start") } : {}),
    ...(f.to ? { to: `${f.to}T23:59:59.999${TEHRAN_OFFSET}` } : {}),
    page,
    pageSize: USAGE_PAGE_SIZE,
  };
}

/** The sentence key when the range ends before it starts; one day (from = to) is a range. */
export function validateUsageFilter(f: UsageFilter): string | null {
  return f.from && f.to && f.from > f.to ? COUPON_KEYS.usage.filters.badRange : null;
}

/** The day a stored instant shows as — the reverse of {@link dayToInstant}. */
export function instantToDay(instant: string | null, edge: "start" | "end"): string {
  if (!instant) return "";
  const at = new Date(instant).getTime() - (edge === "end" ? 1 : 0);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function formFromCoupon(c: AdminCoupon): CouponForm {
  const s = (v: string | number | null) => (v === null ? "" : String(v));
  return {
    owner: c.tenantId === null ? "platform" : "own",
    tenantId: c.tenantId ?? "",
    code: c.code,
    discountType: c.discountType === "fixed_amount" || c.discountType === "free_grant" ? c.discountType : "percentage",
    discountValue: c.discountValue,
    grantVariantId: c.grantVariantId ?? "",
    maxDiscountCap: s(c.maxDiscountCap),
    minPurchaseAmount: s(c.minPurchaseAmount),
    maxPurchaseAmount: s(c.maxPurchaseAmount),
    totalUsageLimit: s(c.totalUsageLimit),
    perUserUsageLimit: String(c.perUserUsageLimit),
    validFrom: instantToDay(c.validFrom, "start"),
    expiresAt: instantToDay(c.expiresAt, "end"),
    isActive: c.isActive,
    visibility: c.visibility === "targeted" ? "targeted" : "public",
    allowedUserIds: c.allowedUserIds.join("\n"),
    activeWeekdays: [...c.activeWeekdays].sort(),
    activeHourFrom: s(c.activeHourFrom),
    activeHourTo: s(c.activeHourTo),
    firstPurchaseOnly: c.firstPurchaseOnly,
    newUserWithinDays: s(c.newUserWithinDays),
    periodUsageLimit: s(c.periodUsageLimit),
    periodDays: s(c.periodDays),
    allowedChannels: [...c.allowedChannels],
    gateways: c.gateways.map((g) => `${g.source}:${g.id}`),
    productIds: c.serviceScopes.flatMap((x) => (x.productId ? [x.productId] : [])).join("\n"),
    variantIds: c.serviceScopes.flatMap((x) => (x.variantId ? [x.variantId] : [])).join("\n"),
    label: c.label ?? "",
    note: c.note ?? "",
  };
}

const CODE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT = /^\d{1,7}$/;

const ids = (text: string) => [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];
const blank = (v: string) => v.trim() === "";

/**
 * `CouponAdminService`'s rules on one value, mirrored so a refusal is caught
 * before the call. Billing still decides; what cannot be known here (a taken
 * code, a user in another tenant) comes back as its refusal sentence.
 */
export function validateCouponForm(f: CouponForm, me: Me | null, original: AdminCoupon | null): CouponFormErrors {
  const errors: CouponFormErrors = {};
  const put = (k: keyof CouponForm, key: string) => {
    errors[k] ??= key;
  };

  if (!CODE.test(f.code.trim().toUpperCase())) put("code", E.code);
  if (!original && isPlatformOwner(me) && f.owner === "tenant" && !UUID.test(f.tenantId.trim())) put("tenantId", E.uuid);

  if (f.discountType === "free_grant") {
    // A free service names the variant it grants and gives no money (F-502-l-c).
    if (!UUID.test(f.grantVariantId.trim())) put("grantVariantId", E.uuid);
    // It is redeemed in the gift box, which reads no purchase, period or clock.
    for (const k of ["minPurchaseAmount", "maxPurchaseAmount", "periodUsageLimit", "periodDays", "activeHourFrom", "activeHourTo", "newUserWithinDays"] as const) {
      if (!blank(f[k])) put(k, E.notForFreeService);
    }
    if (f.validFrom) put("validFrom", E.notForFreeService);
    // Nor a gateway or a service scope (F-502-n): the gift box reads none of them,
    // and an edited coupon keeps the ones it already had unless the form clears them.
    if (f.gateways.length > 0) put("gateways", E.notForFreeService);
    for (const k of ["productIds", "variantIds"] as const) if (ids(f[k]).length > 0) put(k, E.notForFreeService);
  } else {
    const value = f.discountValue.trim();
    if (!DECIMAL.test(value) || Number(value) <= 0) put("discountValue", E.decimal);
    else if (f.discountType === "percentage" && Number(value) > 100) put("discountValue", E.percentMax);
  }

  for (const k of ["maxDiscountCap", "minPurchaseAmount", "maxPurchaseAmount"] as const) {
    if (!blank(f[k]) && !DECIMAL.test(f[k].trim())) put(k, E.decimal);
  }
  if (!blank(f.maxDiscountCap) && f.discountType !== "percentage") put("maxDiscountCap", E.capPercentOnly);
  if (!blank(f.maxDiscountCap) && Number(f.maxDiscountCap) <= 0) put("maxDiscountCap", E.decimal);
  if (!blank(f.maxPurchaseAmount) && Number(f.maxPurchaseAmount) <= 0) put("maxPurchaseAmount", E.decimal);
  if (!blank(f.minPurchaseAmount) && !blank(f.maxPurchaseAmount) && Number(f.maxPurchaseAmount) < Number(f.minPurchaseAmount)) {
    put("maxPurchaseAmount", E.range);
  }

  for (const k of ["totalUsageLimit", "newUserWithinDays", "periodUsageLimit", "periodDays", "activeHourFrom", "activeHourTo"] as const) {
    if (!blank(f[k]) && !INT.test(f[k].trim())) put(k, E.integer);
  }
  if (!INT.test(f.perUserUsageLimit.trim())) put("perUserUsageLimit", E.integer);
  for (const k of ["totalUsageLimit", "newUserWithinDays"] as const) {
    if (!errors[k] && !blank(f[k]) && Number(f[k]) < 1) put(k, E.integer);
  }
  if (original && !errors.totalUsageLimit && !blank(f.totalUsageLimit) && Number(f.totalUsageLimit) < original.usedCount + original.reservedCount) {
    put("totalUsageLimit", E.capacityBelowUsed);
  }

  if (blank(f.activeHourFrom) !== blank(f.activeHourTo)) put(blank(f.activeHourTo) ? "activeHourTo" : "activeHourFrom", E.pair);
  else if (!blank(f.activeHourFrom) && !errors.activeHourFrom && !errors.activeHourTo) {
    const from = Number(f.activeHourFrom);
    const to = Number(f.activeHourTo);
    if (from > 23) put("activeHourFrom", E.range);
    if (to < 1 || to > 24 || from === to) put("activeHourTo", E.range);
  }

  if (blank(f.periodUsageLimit) !== blank(f.periodDays)) put(blank(f.periodUsageLimit) ? "periodUsageLimit" : "periodDays", E.pair);
  else if (!blank(f.periodDays) && (Number(f.periodDays) < 1 || Number(f.periodUsageLimit) < 1)) put("periodDays", E.integer);

  if (f.validFrom && f.expiresAt && dayToInstant(f.validFrom, "start") >= dayToInstant(f.expiresAt, "end")) put("expiresAt", E.dates);
  if (f.validFrom && f.expiresAt && f.validFrom > f.expiresAt) put("expiresAt", E.dates);

  const users = ids(f.allowedUserIds);
  if (users.some((u) => !UUID.test(u))) put("allowedUserIds", E.uuid);
  else if (f.visibility === "targeted" && users.length === 0) put("allowedUserIds", E.targetedNeedsUsers);
  for (const k of ["productIds", "variantIds"] as const) {
    if (ids(f[k]).some((u) => !UUID.test(u))) put(k, E.uuid);
  }
  return errors;
}

const orNull = (v: string) => (blank(v) ? null : v.trim());
const intOrNull = (v: string) => (blank(v) ? null : Number(v.trim()));

/** Every field billing stores, in its wire shape — the one conversion both bodies are built from. */
function wire(f: CouponForm): Required<UpdateCouponBody> {
  return {
    code: f.code.trim().toUpperCase(),
    discountType: f.discountType,
    discountValue: f.discountType === "free_grant" ? "0" : f.discountValue.trim(),
    maxDiscountCap: f.discountType === "percentage" ? orNull(f.maxDiscountCap) : null,
    grantVariantId: f.discountType === "free_grant" ? orNull(f.grantVariantId) : null,
    minPurchaseAmount: orNull(f.minPurchaseAmount),
    maxPurchaseAmount: orNull(f.maxPurchaseAmount),
    totalUsageLimit: intOrNull(f.totalUsageLimit),
    perUserUsageLimit: Number(f.perUserUsageLimit.trim()),
    validFrom: f.validFrom ? dayToInstant(f.validFrom, "start") : null,
    expiresAt: f.expiresAt ? dayToInstant(f.expiresAt, "end") : null,
    isActive: f.isActive,
    visibility: f.visibility,
    allowedUserIds: ids(f.allowedUserIds),
    activeWeekdays: [...f.activeWeekdays].sort((a, b) => a - b),
    activeHourFrom: intOrNull(f.activeHourFrom),
    activeHourTo: intOrNull(f.activeHourTo),
    firstPurchaseOnly: f.firstPurchaseOnly,
    newUserWithinDays: intOrNull(f.newUserWithinDays),
    periodUsageLimit: intOrNull(f.periodUsageLimit),
    periodDays: intOrNull(f.periodDays),
    allowedChannels: [...f.allowedChannels].sort(),
    gateways: f.gateways.map((g): CouponGatewayRef => {
      const [source, id] = g.split(":");
      return { source: source === "platform" ? "platform" : "tenant", id };
    }),
    serviceScopes: [...ids(f.productIds).map((productId) => ({ productId })), ...ids(f.variantIds).map((variantId) => ({ variantId }))],
    label: orNull(f.label),
    note: orNull(f.note),
  };
}

const EMPTY_WIRE = wire(emptyCouponForm());

/**
 * A new coupon: every field that differs from billing's default, so the body
 * reads as what the admin chose. `tenantId` only for the platform owner.
 */
export function createBody(f: CouponForm, me: Me | null): CreateCouponBody {
  const all = wire(f);
  const body: Record<string, unknown> = { code: all.code, discountType: all.discountType, discountValue: all.discountValue, isActive: all.isActive, visibility: all.visibility, perUserUsageLimit: all.perUserUsageLimit };
  for (const [k, v] of Object.entries(all)) {
    if (k in body) continue;
    if (JSON.stringify(v) !== JSON.stringify(EMPTY_WIRE[k as keyof typeof EMPTY_WIRE])) body[k] = v;
  }
  if (isPlatformOwner(me) && f.owner !== "own") body.tenantId = f.owner === "platform" ? null : f.tenantId.trim();
  return body as unknown as CreateCouponBody;
}

/** An edit: only the fields that changed, so a used coupon's frozen value is never restated (F-502-c). */
export function updateBody(f: CouponForm, original: AdminCoupon): UpdateCouponBody {
  const next = wire(f);
  const before = wire(formFromCoupon(original));
  const body: Record<string, unknown> = {};
  for (const k of Object.keys(next) as (keyof typeof next)[]) {
    if (JSON.stringify(next[k]) !== JSON.stringify(before[k])) body[k] = next[k];
  }
  return body as UpdateCouponBody;
}
