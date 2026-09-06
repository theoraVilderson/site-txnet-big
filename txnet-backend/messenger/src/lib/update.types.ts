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
}

export interface BotMessage {
  message_id?: number;
  from?: { id: number | string; language_code?: string; is_bot?: boolean };
  chat?: { id: number | string };
  text?: string;
  contact?: BotContact;
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
