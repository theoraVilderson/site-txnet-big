import { Prisma } from '@prisma/client';

/**
 * The payment id a gateway callback URL carries (F-092-ad, ADR-0046 decision 4).
 *
 * `start` mints the payment row first and stores the gateway's authority only
 * after the gateway answers. A write lost in between leaves a paid payment no
 * authority points to. Naming the payment in the callback URL is what finds it
 * again: the payer's own redirect brings it back, and a provider that lists
 * its unverified payments (Zarinpal `unVerified.json`) echoes the URL back.
 *
 * One query parameter, added to whatever URL the gateway is told — a tenant's
 * panel host or a gateway's own address (F-092-w) keeps its host, path and
 * query.
 */

/** The query parameter. Short, because a gateway may cap the URL's length. */
export const CALLBACK_PAYMENT_PARAM = 'p';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function withPaymentId(callbackUrl: string, paymentId: string): string {
  const url = new URL(callbackUrl);
  url.searchParams.set(CALLBACK_PAYMENT_PARAM, paymentId);
  return url.toString();
}

/** The payment id a value names, or `null` for anything that is not one. */
export function paymentIdOf(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

/** The payment id a callback URL a gateway echoed back names, or `null`. */
export function paymentIdInUrl(callbackUrl: string | null | undefined): string | null {
  if (!callbackUrl) return null;
  try {
    return paymentIdOf(new URL(callbackUrl).searchParams.get(CALLBACK_PAYMENT_PARAM));
  } catch {
    return null;
  }
}

/**
 * Give a payment the authority its write lost — only if it still has none, so
 * nothing overwrites one that arrived meanwhile. The unique index on the column
 * (ADR-0028) refuses an authority another payment already holds. Answers
 * whether this call attached it.
 */
export async function attachAuthority(
  tx: Prisma.TransactionClient,
  paymentId: string,
  authority: string,
): Promise<boolean> {
  const { count } = await tx.paymentTransaction.updateMany({
    where: { id: paymentId, gatewayTrackingCode: null },
    data: { gatewayTrackingCode: authority },
  });
  return count === 1;
}

