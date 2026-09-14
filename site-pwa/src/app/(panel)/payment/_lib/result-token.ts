import { createHmac, timingSafeEqual } from "node:crypto";

import {
  readFailure,
  readSuccess,
  type PaymentFailure,
  type PaymentSuccess,
  type QueryValue,
} from "./payment-result";

export type VerifiedResult =
  | { kind: "success"; success: PaymentSuccess }
  | { kind: "failed"; failure: PaymentFailure }
  /** A verifying payment (F-093-l): the id `/payment/pending` polls. */
  | { kind: "verifying"; paymentId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The outcome `billing`'s callback signed into `?t=`, or `null` when there is
 * nothing trustworthy to show (`contract.payment-result.md` rule 10).
 *
 * The token is `<base64url JSON>.<HMAC-SHA256>` under `PAYMENT_RESULT_SECRET`
 * (`billing-service/.../payment-result-token.ts` writes it). A wrong MAC, an
 * edited body, an expired `e`, or no secret at all is `null` — the page then
 * sends the payer to the financial page, where the real row is. Server only:
 * the secret never reaches a browser bundle.
 *
 * The payload still passes through `readSuccess` / `readFailure`, so rule 4's
 * allowlists hold even for a signed value.
 */
export function readResultToken(raw: QueryValue, secret: string, nowMs = Date.now()): VerifiedResult | null {
  const token = Array.isArray(raw) ? undefined : raw;
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;

  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: { k?: unknown; r?: unknown; a?: unknown; c?: unknown; e?: unknown; p?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.e !== "number" || payload.e * 1000 < nowMs) return null;

  if (payload.k === "s") {
    const ref = typeof payload.r === "string" ? payload.r : undefined;
    return { kind: "success", success: readSuccess(ref, payload.a === 1 ? "1" : undefined) };
  }
  if (payload.k === "v") {
    // Signed or not, it becomes part of a request path: only a uuid is one.
    return typeof payload.p === "string" && UUID.test(payload.p) ? { kind: "verifying", paymentId: payload.p } : null;
  }
  if (payload.k === "f") {
    return { kind: "failed", failure: readFailure(typeof payload.c === "string" ? payload.c : undefined) };
  }
  return null;
}
