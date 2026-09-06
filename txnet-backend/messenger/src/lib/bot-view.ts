/**
 * A `BotView` is one bot screen, described as **intent** rather than as a
 * widget: a body, a set of choices, optionally something to show and a route
 * that does the same job better on the web. It never names Telegram or Bale and
 * never carries a resolved string — the renderer decides the payload
 * (`docs/interfaces/bot-app/contract.md`).
 */

/**
 * An i18n key plus its interpolation values. Never a string this codebase
 * wrote — `raw` is the one exception, and it exists for text another service
 * has *already* translated into the reader's language (an `auth-api` `msg`).
 * Copy authored in a flow would make per-tenant branding impossible (`F-317`).
 */
export interface BotText {
  key?: string;
  values?: Record<string, string | number>;
  /** Already-translated text from another service. Never a literal. */
  raw?: string;
}

/** How a choice is meant to behave, in intent terms. */
export type BotActionKind =
  /** The flow handles it and moves on. */
  | 'choice'
  /** Ask the platform for the sender's own contact card. */
  | 'contact'
  /** Leave the chat for a URL. */
  | 'url'
  /** Open the Mini App at a `panel-web` route. */
  | 'web_app';

export interface BotAction {
  /** Stable across renderings and translations — the flow matches on this. */
  id: string;
  label: BotText;
  kind?: BotActionKind;
  /** Required for `url` and `web_app`. */
  url?: string;
}

export interface BotMedia {
  kind: 'photo' | 'document';
  url: string;
  caption?: BotText;
  /** Bytes, when known — lets the renderer degrade instead of failing (F-302). */
  sizeBytes?: number;
}

export interface BotView {
  /** Screen id, for logs and for the navigation breadcrumb. */
  id: string;
  /**
   * A screen answers three questions at once, and each is a separate field so
   * a flow composes them out of *keys* instead of gluing sentences together:
   *
   * | field | the question it answers |
   * |---|---|
   * | `hint` | why am I seeing this screen again? |
   * | `header` | where am I, and how much is left? |
   * | `summary` | what have I told you so far? |
   * | `body` | what are you asking me now? |
   * | `footer` | what can I do from here? |
   *
   * The renderer joins whichever are present, in that order. Only `body` is
   * required: a screen that needs no orientation carries none.
   */
  body: BotText;
  /** Prepended when a screen is re-shown: what went wrong the first time. */
  hint?: BotText;
  /** Orientation: which conversation this is, and which step of how many. */
  header?: BotText;
  /** The answers already given, echoed back so nothing is invisible. */
  summary?: BotText[];
  /** What follows the question — usually the menu a terminal screen lands on. */
  footer?: BotText;
  /** Rows of choices. The renderer decides what a row becomes. */
  actions?: BotAction[][];
  media?: BotMedia;
  /** The `panel-web` route that does this better, offered *alongside* the chat
   * path — never instead of it (chat-first, ADR-0009). */
  escape?: { url: string; label: BotText };
  /** Take any keyboard down after this view. */
  clearKeyboard?: boolean;
}

/** Resolves an i18n key in the viewer's language. Supplied by the caller, so
 * this unit holds no strings and no locale client. */
export type BotTranslator = (text: BotText) => string;
