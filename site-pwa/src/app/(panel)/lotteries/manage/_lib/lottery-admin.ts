import type { Me } from "@/lib/auth-api";
import type { AdminLottery, AdminLotteryStatus, LotteryDraftBody, LotteryPrizeType } from "@/lib/engagement-api";
import { holdsPermission } from "@/lib/permissions";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ExclusionReason } from "../../_lib/lotteries";

/** The page's strings as generated constants (C-06). */
export const LOTTERY_ADMIN_KEYS = FrontendI18nKeys.common.lotteryAdmin;
const K = LOTTERY_ADMIN_KEYS;
type Key = string;

/** The key `EngagementPermissionGuard` gates on; the spec reads it from the guard. */
export const LOTTERY_MANAGE = "engagement.manage";
export const canManageLotteries = (me: Me | null) => holdsPermission(me?.permissions, LOTTERY_MANAGE);

/** `lotteryDraftSchema`'s and `lotteryCancelSchema`'s bounds; the spec reads them from the schema. */
export const PRIZES_MAX = 20;
export const PRIZE_LABEL_MAX = 80;
export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 2000;
export const WINNERS_MAX = 1000;
export const RESERVES_MAX = 100;
export const REASON_MAX = 500;
/** The service's window for `closesAt` (F-707-i rule 4), at save and again at publish. */
export const CLOSE_MIN_HOURS = 1;
export const CLOSE_MAX_DAYS = 180;

/** Every reason billing refuses this page with (`LotteryAdminRejection`); the spec reads the union. */
export type LotteryAdminRefusal =
  | "invalid_prize"
  | "invalid_close_time"
  | "cancel_reason_required"
  | "coupon_template_not_found"
  | "variant_not_found"
  | "group_not_found"
  | "audience_not_allowed"
  | "lottery_not_found"
  | "not_a_draft"
  | "not_cancellable"
  | "not_drawn";

export const REFUSAL_KEYS: Record<LotteryAdminRefusal, string> = { ...K.refusals, audience_not_allowed: FrontendI18nKeys.common.audience.notAllowed };

export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as LotteryAdminRefusal] : null;
}

/** No cash, no empty prize: every place drawn is a prize (ADR-0111 point 2, F-707-i rule 5). */
export const LOTTERY_PRIZE_TYPES: readonly LotteryPrizeType[] = ["bonus_traffic_gb", "extra_days", "discount_coupon", "free_grant"];
export const PRIZE_TYPE_KEYS: Record<LotteryPrizeType, string> = K.prizeTypes;

/** The preview's reasons, counted; the user page's spec reads the union from the close. */
export const EXCLUDED_COUNT_KEYS: Record<ExclusionReason, string> = K.eligibility.excluded;
export const excludedCountKeyOf = (reason: string): string | null => (reason in EXCLUDED_COUNT_KEYS ? EXCLUDED_COUNT_KEYS[reason as ExclusionReason] : null);

// ------------------------------------------------------------ status and acts

/** The pill. An open lottery past its close is still `published` until the next minute's freeze. */
export function adminStatusKey(l: Pick<AdminLottery, "status" | "closesAt">, now: Date): string {
  if (l.status === "published") return new Date(l.closesAt).getTime() > now.getTime() ? K.status.open : K.status.closing;
  return K.status[l.status];
}

export type LotteryActs = { edit: boolean; remove: boolean; publish: boolean; cancel: boolean };

/** What billing accepts in each status (F-707-i rules 1–3); the page offers nothing else. */
export function actionsFor(status: AdminLotteryStatus): LotteryActs {
  const draft = status === "draft";
  return { edit: draft, remove: draft, publish: draft, cancel: draft || status === "published" };
}

// -------------------------------------------------------- the close, in a zone

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** How far `zone`'s wall clock is ahead of UTC at `at`, in ms. */
function offsetMs(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * `"2026-10-10T20:00"` on `zone`'s wall -> its ISO instant; `null` when it is
 * not a wall clock. The zone is the admin's resolved one (TZ-1-e,
 * `displayZone`); `null` falls back to this browser's clock.
 */
export function wallClockToInstant(wall: string, zone: string | null): string | null {
  const m = WALL.exec(wall.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (!zone) {
    const local = new Date(y, mo - 1, d, h, mi);
    return Number.isNaN(local.getTime()) ? null : local.toISOString();
  }
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  try {
    // Twice: the offset at the answer, not at the guess, decides across a DST change.
    const first = guess - offsetMs(guess, zone);
    return new Date(guess - offsetMs(first, zone)).toISOString();
  } catch {
    return null;
  }
}

/** An instant as `zone`'s wall clock, `YYYY-MM-DDTHH:mm`, for the form's field. */
export function instantToWallClock(instant: string, zone: string | null): string {
  const at = new Date(instant).getTime();
  const shifted = new Date(zone ? at + offsetMs(at, zone) : at - new Date(at).getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

// ------------------------------------------------------------------- the form

/** One prize as the form holds it: every field a string, as typed. */
export interface LotteryPrizeForm {
  label: string;
  prizeType: LotteryPrizeType;
  prizeValue: string;
  couponTemplateId: string;
  couponValidDays: string;
  variantId: string;
  winnersCount: string;
}

export interface LotteryForm {
  userGroupId: string;
  title: string;
  description: string;
  entryMode: "automatic" | "opt_in";
  /** The admin's wall clock, `YYYY-MM-DDTHH:mm`. */
  closesAt: string;
  requiresPhoneVerified: boolean;
  requiresMinAccountAgeHours: string;
  reservesCount: string;
  prizes: LotteryPrizeForm[];
}

export const emptyLotteryPrize = (): LotteryPrizeForm => ({
  label: "",
  prizeType: "bonus_traffic_gb",
  prizeValue: "",
  couponTemplateId: "",
  couponValidDays: "",
  variantId: "",
  winnersCount: "1",
});

/** A first draft: billing's defaults (phone verified, a day old, no reserves). */
export const emptyLotteryForm = (): LotteryForm => ({
  userGroupId: "",
  title: "",
  description: "",
  entryMode: "automatic",
  closesAt: "",
  requiresPhoneVerified: true,
  requiresMinAccountAgeHours: "24",
  reservesCount: "0",
  prizes: [emptyLotteryPrize()],
});

const text = (v: number | string | null) => (v === null ? "" : String(v));

/** The form opened on a draft: a save rewrites it whole, so it restates what is not changed. */
export function lotteryFormFrom(l: AdminLottery, zone: string | null): LotteryForm {
  return {
    userGroupId: l.userGroupId,
    title: l.title,
    description: l.description ?? "",
    entryMode: l.entryMode,
    closesAt: instantToWallClock(l.closesAt, zone),
    requiresPhoneVerified: l.requiresPhoneVerified,
    requiresMinAccountAgeHours: text(l.requiresMinAccountAgeHours),
    reservesCount: text(l.reservesCount),
    prizes: [...l.prizes]
      .sort((a, b) => a.rank - b.rank)
      .map((p) => ({
        label: p.label,
        prizeType: p.prizeType,
        prizeValue: p.prizeValue,
        couponTemplateId: p.couponTemplateId ?? "",
        couponValidDays: text(p.couponValidDays),
        variantId: p.variantId ?? "",
        winnersCount: text(p.winnersCount),
      })),
  };
}

type Errors<T> = Partial<Record<keyof T, Key>>;
type LotteryFields = Pick<LotteryForm, "userGroupId" | "title" | "description" | "closesAt" | "requiresMinAccountAgeHours" | "reservesCount">;

export interface LotteryFormCheck {
  ok: boolean;
  fields: Errors<LotteryFields>;
  prizes: Array<Errors<LotteryPrizeForm>>;
  overall: Key | null;
}

/** billing's `DECIMAL`: no sign, no leading zero, at most two places. */
const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const WHOLE = /^(0|[1-9]\d{0,8})$/;

function cents(v: string): bigint | null {
  const s = v.trim();
  if (!DECIMAL.test(s)) return null;
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
}

function inRange(v: string, min: number, max: number): boolean {
  const s = v.trim();
  if (!WHOLE.test(s)) return false;
  const n = Number(s);
  return n >= min && n <= max;
}

/** Each kind's own fields, the shape billing's `prizeShapeOk` holds. */
function checkPrize(p: LotteryPrizeForm): Errors<LotteryPrizeForm> {
  const e: Errors<LotteryPrizeForm> = {};
  const label = p.label.trim();
  if (!label) e.label = K.errors.labelRequired;
  else if (label.length > PRIZE_LABEL_MAX) e.label = K.errors.labelTooLong;
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
  }
  if (!inRange(p.winnersCount, 1, WINNERS_MAX)) e.winnersCount = K.errors.winners;
  return e;
}

/**
 * What billing would refuse a save on, before the call. The close time is
 * judged against `now` the way the service judges it; publish judges it again,
 * so a draft left too long is refused there with its reason.
 */
export function validateLotteryForm(form: LotteryForm, zone: string | null, now: Date): LotteryFormCheck {
  const fields: Errors<LotteryFields> = {};
  if (!form.userGroupId.trim()) fields.userGroupId = K.errors.groupRequired;
  const title = form.title.trim();
  if (!title) fields.title = K.errors.titleRequired;
  else if (title.length > TITLE_MAX) fields.title = K.errors.titleTooLong;
  if (form.description.trim().length > DESCRIPTION_MAX) fields.description = K.errors.descriptionTooLong;
  const closes = wallClockToInstant(form.closesAt, zone);
  if (!closes) fields.closesAt = K.errors.closeRequired;
  else {
    const ahead = new Date(closes).getTime() - now.getTime();
    if (ahead < CLOSE_MIN_HOURS * 3_600_000) fields.closesAt = K.errors.closeTooSoon;
    else if (ahead > CLOSE_MAX_DAYS * 86_400_000) fields.closesAt = K.errors.closeTooFar;
  }
  if (!inRange(form.requiresMinAccountAgeHours, 0, 24 * 365)) fields.requiresMinAccountAgeHours = K.errors.wholeNumber;
  if (!inRange(form.reservesCount, 0, RESERVES_MAX)) fields.reservesCount = K.errors.reserves;

  const prizes = form.prizes.map(checkPrize);
  const overall = form.prizes.length === 0 ? K.errors.noPrizes : form.prizes.length > PRIZES_MAX ? K.errors.tooManyPrizes : null;
  const ok = overall === null && Object.keys(fields).length === 0 && prizes.every((p) => Object.keys(p).length === 0);
  return { ok, fields, prizes, overall };
}

const nullable = (v: string) => (v.trim() === "" ? null : v.trim());

/**
 * The `.strict()` body, prizes in rank order, the close as an instant. A prize
 * carries its kind's fields and nulls for the rest, so a kind changed in the
 * form does not send the old kind's template or variant. Call after
 * {@link validateLotteryForm}.
 */
export function lotteryDraftBody(form: LotteryForm, zone: string | null): LotteryDraftBody {
  return {
    userGroupId: form.userGroupId.trim(),
    title: form.title.trim(),
    description: nullable(form.description),
    entryMode: form.entryMode,
    closesAt: wallClockToInstant(form.closesAt, zone) as string,
    requiresPhoneVerified: form.requiresPhoneVerified,
    requiresMinAccountAgeHours: Number(form.requiresMinAccountAgeHours.trim()),
    reservesCount: Number(form.reservesCount.trim()),
    prizes: form.prizes.map((p) => {
      const coupon = p.prizeType === "discount_coupon";
      return {
        label: p.label.trim(),
        prizeType: p.prizeType,
        prizeValue: p.prizeType === "free_grant" ? "0" : p.prizeValue.trim(),
        couponTemplateId: coupon ? nullable(p.couponTemplateId) : null,
        couponValidDays: coupon && p.couponValidDays.trim() ? Number(p.couponValidDays.trim()) : null,
        variantId: p.prizeType === "free_grant" ? nullable(p.variantId) : null,
        winnersCount: Number(p.winnersCount.trim()),
      };
    }),
  };
}
