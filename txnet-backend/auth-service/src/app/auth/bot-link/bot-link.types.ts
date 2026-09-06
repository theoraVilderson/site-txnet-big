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
  createdAt: number;
}

// The wire shapes (`BotUpdate`, `BotMessage`, `BotContact`) live in
// `messenger` — one definition, read by both this flow and `bot-service`.
export type { BotUpdate, BotMessage, BotContact } from '@txnet-backend/messenger';
