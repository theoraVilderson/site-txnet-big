import { RedisTtl, otpRealtimeChannel } from '@txnet-backend/shared-core';
import type { OtpDeliveryHandles } from './otp-delivery.store';

/**
 * The fields a 202 hands back (F-067-j), `resendIn` with them.
 *
 * `deliveryId` reads the status; `channel` and `channelToken` hear the result
 * live. A client uses whichever it can and the two are not alternatives it has
 * to choose between — the socket is the fast path and the status is the record
 * (D-15), so a client that opened one and missed an event still reads the
 * other.
 *
 * Built in one place because three routes answer this shape and a fourth will;
 * a field added to two of them and forgotten in the third is the kind of drift
 * only a client discovers.
 */
export function deliveryHandles(delivery: OtpDeliveryHandles) {
  return {
    deliveryId: delivery.deliveryId,
    channel: otpRealtimeChannel(delivery.channelId),
    channelToken: delivery.channelToken,
    ...otpResendIn(),
  };
}

/**
 * The seconds until another code may be asked for, on every code-sent answer:
 * the screen's timer counts the server's own figure (2026-10-19 — the auth
 * pages counted 120s, add-account 60s). The cooldown, not whether a code went
 * out, so a number with no account is answered the same (anti-enumeration).
 */
export function otpResendIn() {
  return { resendIn: RedisTtl.otpCooldown };
}

/** Seconds of the OTP cooldown left, for a code the bot sent at `sentAt` (ms) — its `status` answer. */
export function cooldownLeftSince(sentAt: number): number {
  const elapsed = Math.floor((Date.now() - sentAt) / 1000);
  return Math.max(0, RedisTtl.otpCooldown - elapsed);
}
