/**
 * The slice of a Telegram/Bale `Update` this platform reads.
 *
 * It lives here because it is a *wire shape*, and both consumers see it: the
 * `identity` link flow (a contact, checked against its sender) and `bot-app`
 * (every message and tap). Two copies of it would be two definitions of what a
 * contact is — exactly the thing this unit exists to prevent.
 */
export interface BotUpdate {
  update_id?: number;
  message?: BotMessage;
  callback_query?: BotCallbackQuery;
  /** Read through `parsePaymentEvent` (`payment.ts`), never directly. */
  pre_checkout_query?: BotPreCheckoutQuery;
}

export interface BotMessage {
  message_id?: number;
  from?: { id: number | string; language_code?: string; is_bot?: boolean };
  chat?: { id: number | string };
  text?: string;
  contact?: BotContact;
  successful_payment?: BotSuccessfulPayment;
  /** Sizes of one picture, smallest first (both platforms). Read through `incomingFileOf`. */
  photo?: BotPhotoSize[];
  document?: BotDocument;
  /** The text sent with a photo or a document. */
  caption?: string;
}

export interface BotPhotoSize {
  file_id: string;
  file_size?: number;
}

export interface BotDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/**
 * A file a user sent into the chat (F-309), the same on both platforms: what
 * to ask the platform for (`fileId`, through `getFile`) and what the sender
 * said it is. Nothing here is trusted — the type and the name are the
 * sender's claim, and the domain that takes the bytes checks them itself.
 */
export const BOT_INCOMING_FILE_KINDS = ['photo', 'document'] as const;

export interface BotIncomingFile {
  kind: (typeof BOT_INCOMING_FILE_KINDS)[number];
  fileId: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  caption?: string;
}

/** The file on a message, if any: a photo's largest size, or the document. */
export function incomingFileOf(message: BotMessage | undefined): BotIncomingFile | undefined {
  const caption = typeof message?.caption === 'string' ? message.caption : undefined;
  const photo = message?.photo?.length ? message.photo[message.photo.length - 1] : undefined;
  if (photo?.file_id) {
    return { kind: 'photo', fileId: photo.file_id, ...(photo.file_size ? { sizeBytes: photo.file_size } : {}), ...(caption ? { caption } : {}) };
  }
  const doc = message?.document;
  if (doc?.file_id) {
    return {
      kind: 'document',
      fileId: doc.file_id,
      ...(doc.file_name ? { fileName: doc.file_name } : {}),
      ...(doc.mime_type ? { mimeType: doc.mime_type } : {}),
      ...(doc.file_size ? { sizeBytes: doc.file_size } : {}),
      ...(caption ? { caption } : {}),
    };
  }
  return undefined;
}

/** Same field names on Telegram and Bale (read 2026-09-16). */
export interface BotPreCheckoutQuery {
  id: string;
  from?: { id: number | string; language_code?: string };
  currency: string;
  total_amount: number;
  invoice_payload: string;
}

export interface BotSuccessfulPayment {
  currency: string;
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string;
}

export interface BotCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number | string; language_code?: string };
  message?: BotMessage;
}

export interface BotContact {
  phone_number: string;
  first_name?: string;
  /**
   * The messenger account the contact card belongs to. A contact assembled by
   * hand (possible in unofficial clients) carries someone else's number but
   * either omits this or carries the *sender's* id — comparing it with
   * `message.from.id` is what makes the number trustworthy
   * (`identity/invariants.md` #12).
   */
  user_id?: number | string;
}
