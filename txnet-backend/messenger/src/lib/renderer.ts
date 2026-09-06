import { Injectable, Logger } from '@nestjs/common';
import { BotPlatform } from './bot-platform';
import { capabilitiesOf } from './capabilities';
import { BotAction, BotTranslator, BotView } from './bot-view';
import { InlineButton, ReplyMarkup } from './telegram-like-bot.client';

/**
 * One substitution the renderer made because a capability was missing
 * (`F-302`). It is returned *and* logged: "it works on Telegram and not on
 * Bale" has to be a query, not an investigation
 * (`docs/platform/messenger/contract.md`).
 */
export interface Degradation {
  platform: BotPlatform;
  capability: string;
  view: string;
  substitute: string;
}

export interface RenderedMessage {
  text: string;
  replyMarkup?: ReplyMarkup;
  degradations: Degradation[];
  /**
   * True when the choices were rendered as a numbered list, so the flow knows
   * a bare "2" is an answer rather than free text. `matchAction` handles both
   * cases either way.
   */
  numbered: boolean;
}

/**
 * Turns a `BotView` into one platform's payload.
 *
 * The whole point of the split: a `BotView` names a *choice between N options*,
 * so the same view survives all the way down to a numbered text list with no
 * change in the flow above it. The renderer never throws on a missing
 * capability — it substitutes and continues, and says so.
 */
@Injectable()
export class BotViewRenderer {
  private readonly logger = new Logger(BotViewRenderer.name);

  render(
    platform: BotPlatform,
    view: BotView,
    t: BotTranslator,
  ): RenderedMessage {
    const caps = capabilitiesOf(platform);
    const degradations: Degradation[] = [];
    const note = (capability: string, substitute: string) => {
      const d = { platform, capability, view: view.id, substitute };
      degradations.push(d);
      this.logger.log(
        `degraded platform=${platform} view=${view.id} capability=${capability} -> ${substitute}`,
      );
    };

    // Orientation first, question last: hint (why again), header (where am
    // I), summary (what I already said), body (what is being asked). A user
    // who scrolls back sees a trail of answered steps rather than a wall of
    // identical questions.
    const lines: string[] = [
      ...(view.hint ? [t(view.hint)] : []),
      ...(view.header ? [t(view.header)] : []),
      ...(view.summary ?? []).map(t),
      ...(view.hint || view.header || view.summary?.length ? [''] : []),
      t(view.body),
    ].filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''));

    if (view.media) {
      const ceiling =
        view.media.kind === 'photo'
          ? caps.photoUploadBytes
          : caps.documentUploadBytes;
      if (view.media.sizeBytes && view.media.sizeBytes > ceiling) {
        // Over the platform's ceiling: hand over a link rather than fail the
        // whole screen (F-302). Sending the file itself is the media sender's
        // job, not the renderer's.
        note(`${view.media.kind}UploadBytes`, 'a link to the file');
        lines.push(view.media.url);
      }
    }
    const rows = view.actions ?? [];
    const flat = rows.flat();

    // A contact request can only be made from a reply keyboard, so it wins over
    // every other rendering when the view asks for one.
    const contact = flat.find((a) => a.kind === 'contact');
    if (contact) {
      // Everything else on the screen goes on the *same* reply keyboard. It
      // used to be dropped, which left the one screen a user is most likely to
      // refuse — "share my number" — with no visible way out of it.
      const others = flat.filter((a) => a !== contact && a.kind !== 'url');
      if (caps.requestContact) {
        return this.finish(lines, view, t, degradations, note, false, {
          keyboard: [
            [{ text: t(contact.label), request_contact: true }],
            ...others.map((a) => [{ text: t(a.label) }]),
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        });
      }
      note('requestContact', 'ask the user to type their phone number');
      if (!others.length) {
        return this.finish(lines, view, t, degradations, note, false, undefined);
      }
      return this.finish(lines, view, t, degradations, note, false, {
        keyboard: others.map((a) => [{ text: t(a.label) }]),
        resize_keyboard: true,
        one_time_keyboard: true,
      });
    }

    if (!flat.length) {
      return this.finish(
        lines,
        view,
        t,
        degradations,
        note,
        false,
        view.clearKeyboard ? { remove_keyboard: true } : undefined,
      );
    }

    if (caps.inlineKeyboard) {
      const inline = rows.map((row) =>
        row.map((a) => this.inlineButton(a, t, caps.webApp, note)),
      );
      return this.finish(lines, view, t, degradations, note, false, {
        inline_keyboard: inline,
      });
    }

    if (caps.replyKeyboard) {
      note('inlineKeyboard', 'reply keyboard with numbered labels');
      let n = 0;
      const keyboard = rows.map((row) =>
        row.map((a) => ({ text: `${++n}. ${t(a.label)}` })),
      );
      return this.finish(lines, view, t, degradations, note, true, {
        keyboard,
        resize_keyboard: true,
        one_time_keyboard: true,
      });
    }

    // Last resort: the choices become text the flow accepts as text.
    note('replyKeyboard', 'numbered text list');
    flat.forEach((a, i) => lines.push(`${i + 1}. ${t(a.label)}`));
    return this.finish(lines, view, t, degradations, note, true, undefined);
  }

  /**
   * Maps whatever the user sent back to an action id: an inline callback
   * payload, the number from a numbered list, or the label itself. Returns
   * `null` when it is not an answer to this view, which is how a flow tells a
   * choice from free text.
   */
  matchAction(view: BotView, t: BotTranslator, input: string): string | null {
    const flat = (view.actions ?? []).flat();
    if (!flat.length) return null;
    const raw = input.trim();

    const byId = flat.find((a) => a.id === raw);
    if (byId) return byId.id;

    const index = /^(\d+)[.)]?$/.exec(raw);
    if (index) {
      const picked = flat[Number(index[1]) - 1];
      if (picked) return picked.id;
    }

    const withoutNumber = raw.replace(/^\d+[.)]\s*/, '');
    const byLabel = flat.find(
      (a) => t(a.label).trim() === withoutNumber || t(a.label).trim() === raw,
    );
    return byLabel ? byLabel.id : null;
  }

  private inlineButton(
    action: BotAction,
    t: BotTranslator,
    webApp: boolean,
    note: (capability: string, substitute: string) => void,
  ): InlineButton {
    const text = t(action.label);
    if (action.kind === 'url' && action.url) return { text, url: action.url };
    if (action.kind === 'web_app' && action.url) {
      if (webApp) return { text, web_app: { url: action.url } };
      note('webApp', 'plain URL button to the same panel-web route');
      return { text, url: action.url };
    }
    return { text, callback_data: action.id };
  }

  /** Appends the escape route, then assembles the message. */
  private finish(
    lines: string[],
    view: BotView,
    t: BotTranslator,
    degradations: Degradation[],
    note: (capability: string, substitute: string) => void,
    numbered: boolean,
    replyMarkup: ReplyMarkup | undefined,
  ): RenderedMessage {
    if (view.footer) lines.push('', t(view.footer));
    if (view.escape) {
      // Offered *alongside* the chat path, never instead of it (chat-first).
      const asButton =
        replyMarkup && 'inline_keyboard' in replyMarkup
          ? replyMarkup.inline_keyboard.push([
              { text: t(view.escape.label), url: view.escape.url },
            ])
          : null;
      if (asButton === null) {
        lines.push(`${t(view.escape.label)}: ${view.escape.url}`);
      }
    }

    return {
      text: lines.join('\n'),
      ...(replyMarkup ? { replyMarkup } : {}),
      degradations,
      numbered,
    };
  }
}
