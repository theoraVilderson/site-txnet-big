import { BotContact, BotPlatform, BotView } from '@txnet-backend/messenger';

/** Which conversation the chat is in the middle of. */
export type BotFlow =
  | 'login'
  | 'register'
  | 'forgot'
  | 'accounts'
  | 'accountAdd';

/**
 * Navigation state: the screen, the breadcrumb and a half-typed input.
 *
 * ADR-0010 draws the line here: losing this costs the user one tap, so it
 * lives in Redis with a TTL. Anything a user would have to *redo* — or that a
 * domain would have to reconcile — is not conversation state and belongs in
 * the domain that owns it. Nothing money-adjacent is ever kept here, and
 * neither is a password: it goes straight into the `auth-api` call.
 */
export interface NavState {
  flow: BotFlow;
  step: string;
  /** Collected, non-secret fields: phone, full name, username, reset token. */
  data: Record<string, string>;
  /** Set while an account-link round trip is in flight (`F-0203`). */
  linkToken?: string;
  /** Which platform that link is for — may not be the chat's own. */
  linkPlatform?: BotPlatform;
  /**
   * The screen last rendered. Kept so a *typed* answer ("2", or the label
   * itself) can be matched back to a choice — which is what makes the
   * degraded, keyboard-less rendering a real path rather than a stated one.
   *
   * It is also what makes Back and re-asking possible: a screen the bot has
   * already built can be shown again without the flow that built it being
   * consulted, so neither is a per-flow feature that a flow can forget.
   */
  lastView?: BotView;
  /**
   * The breadcrumb ADR-0010 named: the states this conversation passed
   * through, most recent last, each with the screen that was on it.
   *
   * Without it, one mistyped letter costs the whole conversation — the only
   * exit from step 4 of 6 was Cancel and start again. Snapshots carry an empty
   * `history` of their own and the router keeps at most `HISTORY_LIMIT`, so
   * the entry cannot grow with the length of the conversation.
   */
  history?: NavState[];
}

/** One inbound message, normalized out of whichever platform sent it. */
export interface ChatContext {
  platform: BotPlatform;
  chatId: string;
  /** `message.from.id` — what a shared contact is checked against. */
  senderId?: string | number;
  lang: string;
  text?: string;
  contact?: BotContact;
  /** An inline button's payload, when the user tapped instead of typing. */
  callbackData?: string;
  callbackQueryId?: string;
  /** So a password message can be deleted the moment it is used. */
  messageId?: number;
}

/**
 * What a flow decided: what to show, and what state to keep. `nextState: null`
 * ends the conversation and drops the Redis entry.
 */
export interface FlowResult {
  view: BotView;
  nextState: NavState | null;
  /** Delete the user's own message — a password, never anything else. */
  deleteIncoming?: boolean;
  /**
   * Render this reply in a language other than the one the update arrived in.
   * Set only by the language chooser: a confirmation written in the language
   * the user just asked to leave is the one message they certainly cannot read.
   */
  lang?: string;
}
