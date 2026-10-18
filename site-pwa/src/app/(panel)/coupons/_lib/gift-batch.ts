import type { Me } from "@/lib/auth-api";
import type { GenerateGiftBatchBody } from "@/lib/billing-api";
import { COUPON_KEYS, dayToInstant, type CouponOwnerChoice } from "./coupon-form";
import { isPlatformTenant } from "@/lib/tenant-type";
import { MONEY_MAX_PLACES, MONEY_PATTERN, moneyUnits } from "../../_lib/money";

/** Every string the gift tab can show (C-06). */
export const GIFT_KEYS = COUPON_KEYS.gift;

/** billing's `GIFT_BATCH_MAX` (F-502-d). */
export const GIFT_BATCH_MAX = 5000;

/** billing's `GIFT_CODE_ALPHABET` and `BODY_LENGTH`: a code is `PREFIX-` and ten of these, test-checked against the service. */
export const GIFT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const GIFT_CODE_BODY_LENGTH = 10;

/** How many sample codes the review shows (UX-3-e): enough to see the shape, too few to read as a batch. */
const SAMPLE_CODES = 3;

export interface GiftBatchForm {
  owner: CouponOwnerChoice;
  tenantId: string;
  label: string;
  note: string;
  count: string;
  /** What each code gives: a wallet credit, or a free service (F-502-l-c). */
  kind: "credit" | "service";
  value: string;
  /** A free-service batch only: the catalog variant each code grants. */
  grantVariantId: string;
  prefix: string;
  /** `YYYY-MM-DD`, Tehran's day; the code works through it. */
  expiresAt: string;
}

export type GiftBatchErrors = Partial<Record<keyof GiftBatchForm, string>>;

export function emptyGiftBatchForm(): GiftBatchForm {
  return { owner: "own", tenantId: "", label: "", note: "", count: "10", kind: "credit", value: "", grantVariantId: "", prefix: "", expiresAt: "" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `CouponBatchService.generate`'s rules, mirrored. */
export function validateGiftBatch(f: GiftBatchForm, me: Me | null): GiftBatchErrors {
  const errors: GiftBatchErrors = {};
  if (!f.label.trim()) errors.label = GIFT_KEYS.errors.label;
  const count = f.count.trim();
  if (!/^\d{1,4}$/.test(count) || Number(count) < 1 || Number(count) > GIFT_BATCH_MAX) errors.count = GIFT_KEYS.errors.count;
  if (f.kind === "service") {
    if (!UUID.test(f.grantVariantId.trim())) errors.grantVariantId = COUPON_KEYS.errors.uuid;
  } else if (!MONEY_PATTERN.test(f.value.trim()) || Number(f.value) <= 0) {
    errors.value = COUPON_KEYS.errors.decimal;
  }
  if (f.prefix.trim() && !/^[A-Za-z0-9]{1,8}$/.test(f.prefix.trim())) errors.prefix = GIFT_KEYS.errors.prefix;
  if (isPlatformTenant(me?.tenant?.type) && f.owner === "tenant" && !UUID.test(f.tenantId.trim())) errors.tenantId = COUPON_KEYS.errors.uuid;
  return errors;
}

export function giftBatchBody(f: GiftBatchForm, me: Me | null): GenerateGiftBatchBody {
  const service = f.kind === "service";
  const body: GenerateGiftBatchBody = { label: f.label.trim(), count: Number(f.count.trim()), value: service ? "0" : f.value.trim() };
  if (service) body.grantVariantId = f.grantVariantId.trim();
  if (f.note.trim()) body.note = f.note.trim();
  if (f.prefix.trim()) body.prefix = f.prefix.trim().toUpperCase();
  if (f.expiresAt) body.expiresAt = dayToInstant(f.expiresAt, "end");
  if (isPlatformTenant(me?.tenant?.type) && f.owner !== "own") body.tenantId = f.owner === "platform" ? null : f.tenantId.trim();
  return body;
}

/**
 * Codes in the shape billing will make them (UX-3-e) — invented here, never
 * real ones: rule 10 keeps the batch's codes off the screen, so the review
 * shows only what a code will look like.
 */
export function sampleGiftCodes(prefix: string, count: number): string[] {
  const head = prefix.trim().toUpperCase();
  const draw = new Uint32Array(GIFT_CODE_BODY_LENGTH);
  return Array.from({ length: Math.min(SAMPLE_CODES, count) }, () => {
    const body = Array.from(crypto.getRandomValues(draw), (n) => GIFT_CODE_ALPHABET[n % GIFT_CODE_ALPHABET.length]).join("");
    return head ? `${head}-${body}` : body;
  });
}

/** `count` codes of `value` each, as a decimal string with no trailing zeros, multiplied without a float (C-02). */
export function batchTotal(value: string, count: number): string {
  const units = (moneyUnits(value.trim()) * BigInt(count)).toString().padStart(MONEY_MAX_PLACES + 1, "0");
  const whole = units.slice(0, -MONEY_MAX_PLACES);
  const fraction = units.slice(-MONEY_MAX_PLACES).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
