import { createHmac } from 'node:crypto';

/**
 * The one thing the panel's result page believes (F-093-f).
 *
 * The callback used to redirect with `?ref=…&already=1` / `?error=…`, and the
 * page printed whatever it was given — so `/payment/success?ref=X`, typed by
 * hand, showed a paid top-up that never happened, under our branding. Now the
 * outcome travels as `?t=<body>.<mac>`: a base64url JSON body and an
 * HMAC-SHA256 of it under `PAYMENT_RESULT_SECRET`, which only this service and
 * the panel's server hold. The panel re-computes the MAC and shows nothing it
 * cannot verify (`panel-web/contract.payment-result.md`).
 *
 * The body is the page's inputs and an expiry, nothing more: `k` success or
 * failure, `r` the reference, `a` already paid, `c` the failure code, `e` unix
 * seconds. The panel's `_lib/result-token.ts` is the reader; its test signs
 * with this function, so a format change on one side fails on the other.
 */
export const RESULT_TOKEN_TTL_SEC = 15 * 60;

/**
 * The part of `CallbackOutcome` the page needs, declared here rather than
 * imported: the panel's test imports this file, and one import of the service
 * would pull billing's whole tree into `site-pwa`'s typecheck. A
 * `CallbackOutcome` is assignable to it, which the controller's call proves.
 */
export type ResultOutcome =
  | { kind: 'success'; referenceId: string | null; alreadyPaid: boolean }
  | { kind: 'failed'; code: string };

export type ResultTokenPayload =
  | { k: 's'; r?: string; a?: 1; e: number }
  | { k: 'f'; c: string; e: number };

export function signResultToken(outcome: ResultOutcome, secret: string, nowMs = Date.now()): string {
  // An empty key is a MAC anyone can compute; refuse rather than sign with it.
  if (!secret) throw new Error('PAYMENT_RESULT_SECRET is not set');
  const e = Math.floor(nowMs / 1000) + RESULT_TOKEN_TTL_SEC;
  const payload: ResultTokenPayload =
    outcome.kind === 'failed'
      ? { k: 'f', c: outcome.code, e }
      : {
          k: 's',
          ...(outcome.referenceId ? { r: outcome.referenceId } : {}),
          ...(outcome.alreadyPaid ? { a: 1 as const } : {}),
          e,
        };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
