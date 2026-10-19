import { OtpPurpose } from '../otp/otp.interface';
import { BotPlatform } from '@txnet-backend/messenger';

/**
 * A link the client has been handed but the user has not completed yet.
 * Lives only in Redis (`botlink:token:<token>`): nothing about an
 * uncompleted link belongs in Postgres.
 */
export interface PendingBotLink {
  token: string;
  platform: BotPlatform;
  /** The phone the client asked to receive a code on, normalized. */
  phoneNumber: string;
  /** What the code is for once the link succeeds. */
  purpose: OtpPurpose;
  /** Language of the web request, reused for the bot's own messages. */
  lang: string;
  ip: string;
  state: 'pending' | 'linked' | 'failed';
  /** i18n key explaining a `failed` state, for the client's status poll. */
  failureKey?: string;
  /** Whether the OTP went out after linking. */
  otpSent: boolean;
  /** When it went out (ms): the cooldown the waiting screen counts starts here. */
  codeSentAt?: number;
  createdAt: number;
  /**
   * The `otp:` channel the waiting screen hears the outcome on (RT-1-h).
   * Absent on a link started before it existed: that screen re-reads on mount.
   */
  channelId?: string;
  channelToken?: string;
}

// The wire shapes (`BotUpdate`, `BotMessage`, `BotContact`) live in
// `messenger` — one definition, read by both this flow and `bot-service`.
export type { BotUpdate, BotMessage, BotContact } from '@txnet-backend/messenger';

/** What the waiting client reads (`BotLinkService.status`). */
export interface BotLinkStatus {
  state: PendingBotLink['state'];
  otpSent: boolean;
  /** With `otpSent`: seconds until another code may be asked for, counted from the bot's send. */
  resendIn?: number;
  failureKey?: string;
}
