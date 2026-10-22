import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { RenewalRateRow, SetRenewalRateBody } from "@/lib/catalog-renewal-rates";
import { toEnglishDigits } from "@/util/helper";
import { platformDayStart } from "../../_lib/datetime";
import { UNIT_PRICE, type Errors } from "./catalog-form";

/**
 * A product's renewal-rate form (F-305-g over F-305-b, catalog
 * `contract.renewal-rate.md`): billing's schema (`renewal-rate.schema.ts`)
 * refused here first, with a sentence per field.
 */

const E = FrontendI18nKeys.common.catalog.renewalRate.errors;

/** billing's `RENEWAL_GIB_MAX`: the most GiB one renewal may be set to sell. */
export const RENEWAL_GIB_MAX = 100_000;
/** billing's `RENEWAL_DAYS_MAX`: ten years. */
export const RENEWAL_DAYS_MAX = 3_650;

export interface RenewalRateForm {
  pricePerGib: string;
  pricePerDay: string;
  minGib: string;
  maxGib: string;
  minDays: string;
  maxDays: string;
  /** `YYYY-MM-DD`, the platform's day; blank = from now. */
  day: string;
}

export const emptyRenewalRateForm = (): RenewalRateForm => ({ pricePerGib: "", pricePerDay: "", minGib: "", maxGib: "", minDays: "", maxDays: "", day: "" });

const text = (v: string) => toEnglishDigits(v.trim());

/** A whole number in `0..max`, or `null`. */
function whole(v: string, max: number): number | null {
  const s = text(v);
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
}

/** True when the price is zero — a sold part may not be (`renewal_sold_part_free`). */
const isZero = (price: string) => !/[1-9]/.test(price);

/**
 * The sentence per field billing's schema would refuse with: a price not a
 * decimal of ≤ 8 places, a bound not whole or past its ceiling, min over max
 * (`renewal_bounds_reversed`), nothing sold (`renewal_sells_nothing`), a sold
 * part free (`renewal_sold_part_free`), and a day already past.
 */
export function validateRenewalRateForm(f: RenewalRateForm, today: string): Errors<RenewalRateForm> {
  const errors: Errors<RenewalRateForm> = {};
  if (!UNIT_PRICE.test(text(f.pricePerGib))) errors.pricePerGib = E.price;
  if (!UNIT_PRICE.test(text(f.pricePerDay))) errors.pricePerDay = E.price;
  const [minGib, maxGib] = [whole(f.minGib, RENEWAL_GIB_MAX), whole(f.maxGib, RENEWAL_GIB_MAX)];
  const [minDays, maxDays] = [whole(f.minDays, RENEWAL_DAYS_MAX), whole(f.maxDays, RENEWAL_DAYS_MAX)];
  if (minGib === null) errors.minGib = E.gib;
  if (maxGib === null) errors.maxGib = E.gib;
  if (minDays === null) errors.minDays = E.days;
  if (maxDays === null) errors.maxDays = E.days;
  if (minGib !== null && maxGib !== null && minGib > maxGib) errors.minGib = E.reversed;
  if (minDays !== null && maxDays !== null && minDays > maxDays) errors.minDays = E.reversed;
  if (maxGib === 0 && maxDays === 0) errors.maxGib = E.nothing;
  if (!errors.pricePerGib && (maxGib ?? 0) > 0 && isZero(text(f.pricePerGib))) errors.pricePerGib = E.soldFree;
  if (!errors.pricePerDay && (maxDays ?? 0) > 0 && isZero(text(f.pricePerDay))) errors.pricePerDay = E.soldFree;
  if (f.day !== "" && f.day < today) errors.day = FrontendI18nKeys.common.catalog.errors.pastDay;
  return errors;
}

/** From a day: today means "from now" (its first instant has passed); a later day starts at its first instant. */
export function renewalFrom(day: string, today: string): { effectiveFrom?: string } {
  return day === "" || day <= today ? {} : { effectiveFrom: platformDayStart(day) };
}

/** The body of a form `validateRenewalRateForm` passed. */
export function renewalRateBody(f: RenewalRateForm, today: string): SetRenewalRateBody {
  return {
    pricePerGib: text(f.pricePerGib),
    pricePerDay: text(f.pricePerDay),
    minGib: Number(text(f.minGib)),
    maxGib: Number(text(f.maxGib)),
    minDays: Number(text(f.minDays)),
    maxDays: Number(text(f.maxDays)),
    ...renewalFrom(f.day, today),
  };
}

/** Whether a row is still ahead of `now` — scheduled, not yet in effect. */
export const isScheduled = (row: Pick<RenewalRateRow, "effectiveFrom">, now: Date) => new Date(row.effectiveFrom) > now;
