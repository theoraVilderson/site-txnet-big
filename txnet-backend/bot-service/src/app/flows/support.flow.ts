import { Injectable } from '@nestjs/common';
import { BotAction, BotText, BotView } from '@txnet-backend/messenger';
import { SUPPORT_CALLBACK_PREFIX, supportOpenCallback } from '@txnet-backend/shared-core';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotKey, BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import {
  SupportApiClient,
  SupportCallContext,
  SupportConversation,
  SupportMessage,
  SupportSenderKind,
  SupportStatus,
  SupportThread,
} from '../support-api/support-api.client';
import { ChatFiles } from './chat-files';
import { ACTIONS, say, view } from './views';

/**
 * support's refusals with a sentence of the bot's own (`ConversationRejection`,
 * the user routes'). One not here — a newer support — is told as support's
 * translated `msg`.
 */
export const SUPPORT_REFUSAL_KEYS: Record<string, BotKey> = BotKeys.support.refusals;

const STATUS_KEYS: Record<SupportStatus, BotKey> = BotKeys.support.status;
const WHO_KEYS: Record<Exclude<SupportSenderKind, 'user'>, BotKey> = {
  agent: BotKeys.support.who.agent,
  system: BotKeys.support.who.system,
  bot: BotKeys.support.who.bot,
  ai: BotKeys.support.who.ai,
};

/** `sup:<kind>:…` — every button names its thread, so a tap on an old screen still means what it says. */
export const SUPPORT_ACTION_PREFIX = SUPPORT_CALLBACK_PREFIX;
export const supportAction = {
  /** The one a reply or resolve notice carries (shared-core, auth-service sends it). */
  open: supportOpenCallback,
  category: (categoryId: string) => `${SUPPORT_ACTION_PREFIX}c:${categoryId}`,
  /** Two ids do not fit 64 bytes as text, so each rides as its 22-character base64url (51 bytes). */
  file: (conversationId: string, attachmentId: string) => `${SUPPORT_ACTION_PREFIX}f:${compact(conversationId)}:${compact(attachmentId)}`,
  rate: (conversationId: string, score: number) => `${SUPPORT_ACTION_PREFIX}r:${conversationId}:${score}`,
  reopen: (conversationId: string) => `${SUPPORT_ACTION_PREFIX}x:${conversationId}`,
};

export const SUPPORT_THREAD_STEP = 'support.thread';
export const SUPPORT_COMPOSE_STEP = 'support.compose';

/** A long message is cut on the screen; the panel has it whole. Six of these stay under a chat message's 4096. */
const LINE_MAX = 500;
/** Buttons for files, newest messages' first. */
const FILE_BUTTONS_MAX = 5;

const all: BotAction = { id: ACTIONS.support, label: { key: BotKeys.action.supportAll } };

/**
 * Support from the chat (F-309): the panel's own `/api/support/*` routes,
 * through the gate, so a conversation started here is the one the panel shows
 * and an agent answers (ADR-0009, ADR-0112). support decides who sees what,
 * what may be sent, and what each status means; this only shows it.
 *
 * The thread being looked at is navigation state (`support.thread` +
 * its id): typed text goes to it as a reply and a photo or document as an
 * attachment. The message is support's the moment it is sent (ADR-0010), so
 * nothing here can be lost but the screen. A reply notice's button opens its
 * thread from any state, ready for the answer.
 */
@Injectable()
export class SupportFlow {
  constructor(
    private readonly api: SupportApiClient,
    private readonly access: ChatAccess,
    private readonly files: ChatFiles,
  ) {}

  /** The user's threads, newest activity first, and a new one. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();
    const read = await this.api.conversations(call);
    if (!read.ok || !read.data) return { view: say('support.failed', { raw: read.msg }), nextState: null };
    const newRow: BotAction[] = [{ id: ACTIONS.supportNew, label: { key: BotKeys.action.supportNew } }];
    const items = read.data.items;
    if (items.length === 0) return { view: view('support.none', { key: BotKeys.support.none }, [newRow]), nextState: null };
    return {
      view: view(
        'support.list',
        { key: BotKeys.support.list },
        [
          ...items.map((c) => [
            {
              id: supportAction.open(c.id),
              label: {
                key: BotKeys.support.item,
                values: {
                  subject: plain(c.subject),
                  status: { key: STATUS_KEYS[c.status] },
                  unread: c.unread > 0 ? { key: BotKeys.support.unread, values: { n: c.unread } } : plain(''),
                },
              },
            },
          ]),
          newRow,
        ],
      ),
      nextState: null,
    };
  }

  /** A `sup:` button. Unknown kinds open the list. */
  async tap(ctx: ChatContext, actionId: string): Promise<FlowResult> {
    if (actionId === ACTIONS.supportNew) return this.newThread(ctx);
    const [kind, a, b] = actionId.slice(SUPPORT_ACTION_PREFIX.length).split(':');
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();

    if (kind === 'o' && a) return this.thread(call, a);
    if (kind === 'c' && a) return this.compose(a);
    if (kind === 'f' && a && b) return this.file(call, expand(a), expand(b));
    if (kind === 'r' && a && b) {
      const done = await this.api.rate(a, Number(b), call);
      return this.thread(call, a, done.ok ? { key: BotKeys.support.rated } : refusal(done.error?.reason, done.msg));
    }
    if (kind === 'x' && a) {
      const done = await this.api.reopen(a, call);
      return this.thread(call, a, done.ok ? undefined : refusal(done.error?.reason, done.msg));
    }
    return this.start(ctx);
  }

  /** Typed text or a file, while composing a new thread or looking at one. */
  async handle(ctx: ChatContext, state: NavState, actionId: string | null): Promise<FlowResult> {
    if (actionId) return this.tap(ctx, actionId);
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();
    const text = ctx.text?.trim() ?? '';

    if (state.step === SUPPORT_COMPOSE_STEP) {
      if (ctx.file || !text) return { view: say('support.compose', { key: BotKeys.support.composeFileFirst }), nextState: state };
      const opened = await this.api.open({ body: text, ...(state.data.categoryId ? { categoryId: state.data.categoryId } : {}) }, call);
      if (!opened.ok || !opened.data) return { view: say('support.compose', refusal(opened.error?.reason, opened.msg)), nextState: state };
      return this.thread(call, opened.data.id);
    }

    const id = state.data.conversationId;
    if (!id) return this.start(ctx);
    if (ctx.file) {
      const file = await this.files.download(ctx, ctx.file);
      if (!file) return this.thread(call, id, { key: BotKeys.support.fileUnreadable });
      const sent = await this.api.upload(id, [file], ctx.file.caption?.trim() || undefined, call);
      return this.thread(call, id, sent.ok ? undefined : refusal(sent.error?.reason, sent.msg));
    }
    if (!text) return this.thread(call, id);
    const sent = await this.api.send(id, text, call);
    return this.thread(call, id, sent.ok ? undefined : refusal(sent.error?.reason, sent.msg));
  }

  /** A file sent while no thread is open: it has nowhere to go. */
  fileOutside(): FlowResult {
    return {
      view: view('support.fileOutside', { key: BotKeys.support.fileOutside }, [[{ id: ACTIONS.support, label: { key: BotKeys.action.support } }]]),
      nextState: null,
    };
  }

  private async newThread(ctx: ChatContext): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return this.signedOut();
    const read = await this.api.categories(call);
    // No categories (or none readable) is not a reason to refuse: support files it uncategorised.
    const categories = read.ok && read.data ? read.data : [];
    if (categories.length === 0) return this.compose(null);
    return {
      view: view(
        'support.category',
        { key: BotKeys.support.category },
        categories.map((c) => [{ id: supportAction.category(c.id), label: plain(c.name) }]),
      ),
      nextState: null,
    };
  }

  private compose(categoryId: string | null): FlowResult {
    return {
      view: view('support.compose', { key: BotKeys.support.compose }, [[all]]),
      nextState: { flow: 'support', step: SUPPORT_COMPOSE_STEP, data: categoryId ? { categoryId } : {} },
    };
  }

  /** The latest messages, read up to the last, with what the thread's status allows. */
  private async thread(call: SupportCallContext, id: string, hint?: BotText): Promise<FlowResult> {
    const read = await this.api.thread(id, call);
    if (!read.ok || !read.data) return { view: say('support.failed', refusal(read.error?.reason, read.msg)), nextState: null };
    const t = read.data;
    const c = t.conversation;
    // Looking is reading — as on the panel; a failed mark costs an unread count, nothing else.
    if (c.lastSeq > 0) await this.api.read(c.id, c.lastSeq, call);

    const buttons: BotAction[][] = fileButtons(c.id, t.messages);
    if ((c.status === 'resolved' || c.status === 'closed') && !c.rating) {
      buttons.push([1, 2, 3, 4, 5].map((n) => ({ id: supportAction.rate(c.id, n), label: { key: BotKeys.action.supportRate, values: { n } } })));
    }
    if (c.status === 'closed') buttons.push([{ id: supportAction.reopen(c.id), label: { key: BotKeys.action.supportReopen } }]);
    buttons.push([{ id: supportAction.open(c.id), label: { key: BotKeys.action.supportRefresh } }, all]);

    const screen: BotView = { ...view('support.thread', threadText(t), buttons), ...(hint ? { hint } : {}) };
    return { view: screen, nextState: { flow: 'support', step: SUPPORT_THREAD_STEP, data: { conversationId: c.id } } };
  }

  private async file(call: SupportCallContext, conversationId: string, attachmentId: string): Promise<FlowResult> {
    const got = await this.api.attachment(conversationId, attachmentId, call);
    if (!got.ok || !got.data) return this.thread(call, conversationId, refusal(got.error?.reason, got.msg));
    const shown = await this.thread(call, conversationId);
    return { ...shown, document: got.data };
  }

  private async callContext(ctx: ChatContext): Promise<SupportCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken } : null;
  }

  private signedOut(): FlowResult {
    return { view: say('support.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
  }
}

function threadText(t: SupportThread): BotText {
  const c: SupportConversation = t.conversation;
  const prompt = c.status === 'closed' ? BotKeys.support.prompt.closed : c.status === 'resolved' ? BotKeys.support.prompt.resolved : BotKeys.support.prompt.reply;
  const lines = t.messages.map((m) => line(m));
  return {
    key: BotKeys.support.thread,
    values: {
      subject: plain(c.subject),
      status: { key: STATUS_KEYS[c.status] },
      earlier: t.hasEarlier ? { key: BotKeys.support.earlier } : plain(''),
      // Each line is its own sentence; joined as data, so no template holds a list.
      messages: { raw: lines.map((_, i) => `{{m${i}}}`).join('\n\n'), values: Object.fromEntries(lines.map((l, i) => [`m${i}`, l])) },
      prompt: { key: prompt },
    },
  };
}

function line(m: SupportMessage): BotText {
  const who: BotText = { key: m.mine || m.senderKind === 'user' ? BotKeys.support.who.me : WHO_KEYS[m.senderKind] };
  const body = m.body.length > LINE_MAX ? `${m.body.slice(0, LINE_MAX)}…` : m.body;
  const names = m.attachments.map((a) => `\n📎 ${a.fileName}`).join('');
  return { key: BotKeys.support.line, values: { who, body: plain(`${body}${names}`) } };
}

/** One button per file support will hand over — clean and not expired — newest last on screen. */
function fileButtons(conversationId: string, messages: SupportMessage[]): BotAction[][] {
  const files = messages.flatMap((m) => m.attachments.filter((a) => a.scanStatus === 'clean' && !a.expired));
  return files.slice(-FILE_BUTTONS_MAX).map((a) => [{ id: supportAction.file(conversationId, a.id), label: { key: BotKeys.action.supportFile, values: { name: plain(a.fileName) } } }]);
}

/** A reason's own sentence; an unknown one falls back to support's translated `msg`. */
function refusal(reason: string | null | undefined, msg?: string): BotText {
  if (reason && reason in SUPPORT_REFUSAL_KEYS) return { key: SUPPORT_REFUSAL_KEYS[reason] };
  return msg ? { raw: msg } : { key: BotKeys.common.tryAgain };
}

/**
 * Text a person wrote (a subject, a message, a file name), as data: escaped
 * for the HTML parse mode every screen is sent in, and never interpolated —
 * a `{{x}}` someone typed stays as typed.
 */
function plain(value: string): BotText {
  return { raw: '{{v}}', values: { v: value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') } };
}

/** A UUID as 22 base64url characters, and back. */
function compact(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

function expand(short: string): string {
  const hex = Buffer.from(short, 'base64url').toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
