import { OtpChannel, OtpPurpose } from '../otp.interface';

/**
 * The multi-provider token holding every sender this service was built with.
 *
 * `OtpChannelRegistry` injects the array and keys it by each sender's own
 * `channel`, so adding a messenger is a sender class plus one entry in
 * `auth.module.ts` — the one place that names the concrete classes — and never
 * a change to the registry's arity.
 *
 * The residual limit is correct and deliberate: `OtpChannel` is a Prisma enum,
 * so a genuinely new channel is also an enum migration. This token removes the
 * wiring cost, not the schema one.
 */
export const OTP_SENDERS = Symbol('OTP_SENDERS');

export interface IOtpSender {
  readonly channel: OtpChannel;
  /**
   * Whether the channel can actually send right now — for the **tenant in
   * scope**, since a bot token belongs to that tenant's `BotIntegration` and
   * not to the environment (F-066-i). An allowed-but-unconfigured channel is
   * never offered to a client — see `OtpChannelRegistry`.
   *
   * Asynchronous because answering it can mean a vault read. A sender whose
   * answer is a config lookup may still return a plain boolean.
   */
  isConfigured(): boolean | Promise<boolean>;
  /**
   * True for the messenger channels: they can only deliver to a chat id, so
   * the user must have linked (and contact-verified) that messenger first.
   * SMS needs nothing beyond the phone number.
   */
  readonly requiresLinkedAccount: boolean;
  /**
   * The one purpose this channel may carry, when it is reserved to one. `email`
   * is (F-035-g, D-39): it proves a user reads an address and nothing more, so
   * it is never a login channel and `email_verify` is never sent any other
   * way. A reserved channel is outside `OTP_ALLOWED_CHANNELS` altogether — its
   * only gate is being configured. `OtpChannelRegistry.assertUsable` enforces
   * the pairing in both directions.
   */
  readonly onlyFor?: OtpPurpose;
  /** `phoneNumber` is the destination: for `email_verify`, an email address. */
  send(
    phoneNumber: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void>;
}
