import { OtpPurpose } from '../otp/otp.interface';
import { BotPlatform } from '../otp/senders/bot-client.registry';

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

/** The slice of a Telegram/Bale `Update` this service reads. */
export interface BotUpdate {
  update_id?: number;
  message?: BotMessage;
}

export interface BotMessage {
  message_id?: number;
  from?: { id: number | string; language_code?: string; is_bot?: boolean };
  chat?: { id: number | string };
  text?: string;
  contact?: BotContact;
}

export interface BotContact {
  phone_number: string;
  first_name?: string;
  /**
   * The messenger account the contact card belongs to. A contact assembled by
   * hand (possible in unofficial clients) carries someone else's number but
   * either omits this or carries the *sender's* id — comparing it with
   * `message.from.id` is what makes the number trustworthy.
   */
  user_id?: number | string;
}
