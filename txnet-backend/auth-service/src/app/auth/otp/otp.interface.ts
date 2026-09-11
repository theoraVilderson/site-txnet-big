import { OtpChannel, OtpPurpose } from '@prisma/client';
import type { OtpDeliveryHandles } from './otp-delivery.store';

// Re-exported so the rest of the app can keep importing from
// './otp.interface' even if the underlying source ever changes.
export { OtpChannel, OtpPurpose };

export const OTP_SERVICE = Symbol('OTP_SERVICE');

/**
 * The wire between `auth-service` and the worker that triggers a send
 * (F-067-a). It carries **no code** — the code does not exist yet when this is
 * published, and identity/invariants.md #2 is why it never will outside the
 * process that sends it.
 *
 * `tenantId` rides on the message because the consumer is another process with
 * no ambient scope: every key and every lookup on the delivery side derives
 * from it (ADR-0023, ADR-0024).
 */
export interface OtpDeliveryRequest {
  tenantId: string;
  phoneNumber: string;
  purpose: OtpPurpose;
  channel: OtpChannel;
  requestIp: string;
  lang: string;
  deliveryId: string;
  /**
   * The realtime channel this send's result is published to (F-067-j). It
   * rides the message for the same reason `tenantId` does: the process that
   * publishes the result is not the process that minted the channel, and it
   * has no way to look one up.
   */
  channelId: string;
}

/** What one delivery attempt did. `false` is a refusal, not a crash. */
export interface OtpDeliveryResult {
  delivered: boolean;
  failureKey?: string;
}

export interface IOtpService {
  /**
   * Take the flood-control locks, then hand the send to the worker and return.
   * The handles are the caller's, because the caller is what answers the 202
   * whether or not a code was actually issued (`OtpDeliveryStore.mintHandles`).
   */
  issueOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    channel: OtpChannel,
    requestIp: string,
    lang: string,
    delivery: OtpDeliveryHandles,
  ): Promise<void>;
  /**
   * Draw the code, store its hash, and send it. Called only from the internal
   * seam, never from a user's request — that separation is the whole feature.
   */
  deliverOtp(request: OtpDeliveryRequest): Promise<OtpDeliveryResult>;
  verifyOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    inputCode: string,
  ): Promise<boolean>;
}
