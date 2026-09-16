import type { Me } from "@/lib/auth-api";
import type { GenerateGiftBatchBody } from "@/lib/billing-api";
import { COUPON_KEYS, dayToInstant, isPlatformOwner, type CouponOwnerChoice } from "./coupon-form";

/** Every string the gift tab can show (C-06). */
export const GIFT_KEYS = COUPON_KEYS.gift;

/** billing's `GIFT_BATCH_MAX` (F-502-d). */
export const GIFT_BATCH_MAX = 5000;

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
  tenantIds: string;
}

export type GiftBatchErrors = Partial<Record<keyof GiftBatchForm, string>>;

export function emptyGiftBatchForm(): GiftBatchForm {
  return { owner: "own", tenantId: "", label: "", note: "", count: "10", kind: "credit", value: "", grantVariantId: "", prefix: "", expiresAt: "", tenantIds: "" };
}

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (text: string) => [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

/** `CouponBatchService.generate`'s rules, mirrored. */
export function validateGiftBatch(f: GiftBatchForm, me: Me | null): GiftBatchErrors {
  const errors: GiftBatchErrors = {};
  if (!f.label.trim()) errors.label = GIFT_KEYS.errors.label;
  const count = f.count.trim();
  if (!/^\d{1,4}$/.test(count) || Number(count) < 1 || Number(count) > GIFT_BATCH_MAX) errors.count = GIFT_KEYS.errors.count;
  if (f.kind === "service") {
    if (!UUID.test(f.grantVariantId.trim())) errors.grantVariantId = COUPON_KEYS.errors.uuid;
  } else if (!DECIMAL.test(f.value.trim()) || Number(f.value) <= 0) {
    errors.value = COUPON_KEYS.errors.decimal;
  }
  if (f.prefix.trim() && !/^[A-Za-z0-9]{1,8}$/.test(f.prefix.trim())) errors.prefix = GIFT_KEYS.errors.prefix;
  if (isPlatformOwner(me) && f.owner === "tenant" && !UUID.test(f.tenantId.trim())) errors.tenantId = COUPON_KEYS.errors.uuid;
  if (ids(f.tenantIds).some((t) => !UUID.test(t))) errors.tenantIds = COUPON_KEYS.errors.uuid;
  return errors;
}

export function giftBatchBody(f: GiftBatchForm, me: Me | null): GenerateGiftBatchBody {
  const service = f.kind === "service";
  const body: GenerateGiftBatchBody = { label: f.label.trim(), count: Number(f.count.trim()), value: service ? "0" : f.value.trim() };
  if (service) body.grantVariantId = f.grantVariantId.trim();
  if (f.note.trim()) body.note = f.note.trim();
  if (f.prefix.trim()) body.prefix = f.prefix.trim().toUpperCase();
  if (f.expiresAt) body.expiresAt = dayToInstant(f.expiresAt, "end");
  if (isPlatformOwner(me) && f.owner !== "own") {
    body.tenantId = f.owner === "platform" ? null : f.tenantId.trim();
    if (f.owner === "platform" && ids(f.tenantIds).length > 0) body.tenantIds = ids(f.tenantIds);
  }
  return body;
}

/**
 * Hand the browser a file built from text. The CSV never touches storage or a
 * URL that outlives the click: the object URL is revoked at once.
 */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  // A BOM so a spreadsheet opens the file as UTF-8.
  const url = URL.createObjectURL(new Blob(["﻿", text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
