import type { CreatePackageBody, MeterRateEdit, MeterRateInput, PackageMeterRate, TenantPackage, UpdatePackageBody } from "@/lib/tenant-api";
import { RESELLER_KEYS, type Errors } from "./resellers";

/** The packages page's strings (C-06). */
export const PACKAGE_KEYS = RESELLER_KEYS.packages;
const K = PACKAGE_KEYS;

/** shared-core's `TENANT_FEATURE_KEYS`, in its order; the spec holds the two together. */
export const PACKAGE_FEATURE_KEYS = [
  "ai_recommendation",
  "spin_wheel",
  "affiliate_system",
  "coupon_engine",
  "custom_bot_telegram",
  "custom_bot_bale",
  "own_gateway",
  "own_sms",
  "multi_currency",
  "dedicated_node_pool",
] as const;

/** A GiB in bytes: `vpn.traffic`'s unit, as a rate card prices it (F-118-m). */
export const GIB = 2 ** 30;

/** 30 days in seconds: the period an unlimited plan's flat wholesale price is asked for (D-59 (c)). */
export const WHOLESALE_PERIOD = 30 * 24 * 3600;

/**
 * The platform meters a package prices on this form (F-118-n1): what a
 * reseller resells on the platform's panels, each with the field's own words.
 * VPN traffic per GiB (F-118-n3), and an unlimited plan's flat price per 30
 * days, charged pro rata to the days sold (F-118-z). A rate on another meter,
 * or in another unit, is shown and left alone ({@link otherRates}).
 */
export const WHOLESALE_METERS = [
  { meterKey: "vpn.traffic", unitSize: GIB, label: K.form.rate, hint: K.form.rateHint, perUnit: K.perGib },
  {
    meterKey: "vpn.unlimited.time",
    unitSize: WHOLESALE_PERIOD,
    label: K.form.unlimitedRate,
    hint: K.form.unlimitedRateHint,
    perUnit: K.perPeriod,
  },
] as const;
type WholesaleMeter = (typeof WHOLESALE_METERS)[number]["meterKey"];

// tenant-package.schema.ts's shapes, so a refusal is caught before the call.
const PRICE = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const UNIT_PRICE = /^(0|[1-9]\d{0,9})(\.\d{1,8})?$/;
const NAME_MAX = 80;
const positive = (s: string) => /[1-9]/.test(s);

/** A rate field that is filled but not a rate the schema takes. */
export function badRate(raw: string): boolean {
  const v = raw.trim();
  return v !== "" && (!UNIT_PRICE.test(v) || !positive(v));
}

export interface PackageForm {
  name: string;
  /** Empty = not sold for that period. */
  monthlyPrice: string;
  yearlyPrice: string;
  featureKeys: string[];
  /** The price per unit, by meter; empty = no rate. */
  rates: Record<WholesaleMeter, string>;
}

const noRates = (): PackageForm["rates"] => Object.fromEntries(WHOLESALE_METERS.map((m) => [m.meterKey, ""])) as PackageForm["rates"];

export const emptyPackageForm = (): PackageForm => ({ name: "", monthlyPrice: "", yearlyPrice: "", featureKeys: [], rates: noRates() });

/** The form's own rate for `meter`: the rate in force, only when it is in the form's unit. */
function formRate(p: TenantPackage, meter: (typeof WHOLESALE_METERS)[number]): PackageMeterRate | undefined {
  return p.meterRates.find((r) => r.meterKey === meter.meterKey && r.unitSize === String(meter.unitSize));
}

export function packageFormOf(p: TenantPackage): PackageForm {
  const rates = noRates();
  for (const m of WHOLESALE_METERS) rates[m.meterKey] = formRate(p, m)?.unitPrice ?? "";
  return { name: p.name, monthlyPrice: p.monthlyPrice ?? "", yearlyPrice: p.yearlyPrice ?? "", featureKeys: [...p.includedFeatureKeys], rates };
}

/**
 * The rates in force this form does not edit — another meter, or another
 * unit — shown as they are. A blank field never touches one: the form cannot
 * say what it would mean per GiB or per 30 days.
 */
export function otherRates(p: TenantPackage): PackageMeterRate[] {
  return p.meterRates.filter((r) => !WHOLESALE_METERS.some((m) => formRate(p, m) === r));
}

export function validatePackage(form: PackageForm): Errors<PackageForm> {
  const errors: Errors<PackageForm> = {};
  const name = form.name.trim();
  if (!name || name.length > NAME_MAX) errors.name = K.errors.name;
  const bad = (raw: string) => {
    const v = raw.trim();
    return v !== "" && (!PRICE.test(v) || !positive(v));
  };
  if (bad(form.monthlyPrice)) errors.monthlyPrice = K.errors.price;
  if (bad(form.yearlyPrice)) errors.yearlyPrice = K.errors.price;
  if (!form.monthlyPrice.trim() && !form.yearlyPrice.trim()) errors.monthlyPrice = K.errors.unpriced;
  if (WHOLESALE_METERS.some((m) => badRate(form.rates[m.meterKey]))) errors.rates = K.errors.rate;
  return errors;
}

const rateOf = (meter: (typeof WHOLESALE_METERS)[number], unitPrice: string): MeterRateInput => ({
  meterKey: meter.meterKey,
  unitSize: String(meter.unitSize),
  unitPrice,
});

/** `POST /tenant-packages`'s body; call after {@link validatePackage}. */
export function createPackageBody(form: PackageForm): CreatePackageBody {
  const monthly = form.monthlyPrice.trim();
  const yearly = form.yearlyPrice.trim();
  const rates = WHOLESALE_METERS.flatMap((m) => {
    const v = form.rates[m.meterKey].trim();
    return v ? [rateOf(m, v)] : [];
  });
  return {
    name: form.name.trim(),
    ...(monthly ? { monthlyPrice: monthly } : {}),
    ...(yearly ? { yearlyPrice: yearly } : {}),
    includedFeatureKeys: [...form.featureKeys],
    ...(rates.length > 0 ? { meterRates: rates } : {}),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k) => b.includes(k));

/**
 * `PATCH /tenant-packages/:id`'s body: only what differs from `p`, or `null`
 * when nothing does. A cleared price is `null`; a cleared rate is
 * `unitPrice: null`, which switches the meter off for every reseller on the
 * package (`tenant/contract.admin.md`). Call after {@link validatePackage}.
 */
export function updatePackageBody(p: TenantPackage, form: PackageForm): UpdatePackageBody | null {
  const body: UpdatePackageBody = {};
  const name = form.name.trim();
  if (name !== p.name) body.name = name;
  const monthly = form.monthlyPrice.trim() || null;
  if (monthly !== p.monthlyPrice) body.monthlyPrice = monthly;
  const yearly = form.yearlyPrice.trim() || null;
  if (yearly !== p.yearlyPrice) body.yearlyPrice = yearly;
  if (!sameSet(form.featureKeys, p.includedFeatureKeys)) body.includedFeatureKeys = [...form.featureKeys];
  const rates: MeterRateEdit[] = [];
  for (const m of WHOLESALE_METERS) {
    const was = formRate(p, m)?.unitPrice ?? "";
    const now = form.rates[m.meterKey].trim();
    if (now === was) continue;
    rates.push(now ? rateOf(m, now) : { meterKey: m.meterKey, unitPrice: null });
  }
  if (rates.length > 0) body.meterRates = rates;
  return Object.keys(body).length > 0 ? body : null;
}
