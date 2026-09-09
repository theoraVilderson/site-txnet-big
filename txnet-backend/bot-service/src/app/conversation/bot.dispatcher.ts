import { Injectable, Logger } from '@nestjs/common';
import {
  BotClientRegistry,
  BotViewRenderer,
  capabilitiesOf,
} from '@txnet-backend/messenger';
import { BotCopy } from '../locale/bot-copy';
import { ChatLanguage } from '../locale/chat-language';
import { ConversationStore } from './conversation.store';
import { ConversationRouter } from './router';
import { ChatContext } from './nav.types';

/**
 * Runs one update end to end: route it, render the screen for *this* platform,
 * send it, and remember what was shown.
 *
 * Never throws. An update the bot cannot handle is a message the user does not
 * get — not a non-2xx, which would make the platform redeliver the same update
 * forever.
 */
@Injectable()
export class BotDispatcher {
  private readonly logger = new Logger(BotDispatcher.name);

  constructor(
    private readonly router: ConversationRouter,
    private readonly nav: ConversationStore,
    private readonly renderer: BotViewRenderer,
    private readonly copy: BotCopy,
    private readonly langs: ChatLanguage,
    private readonly bots: BotClientRegistry,
  ) {}

  async handle(rawCtx: ChatContext): Promise<void> {
    // What the normalizer read off the update is the messenger's *hint* about
    // this user's phone. What the chat is actually spoken to in is decided
    // here, once, before anything reads `ctx.lang` (`ChatLanguage`).
    const ctx: ChatContext = {
      ...rawCtx,
      lang: await this.langs.resolve(
        rawCtx.integration,
        rawCtx.chatId,
        rawCtx.lang,
      ),
    };
    const client = await this.bots.client(
      ctx.integration,
      'bot-app:BotDispatcher',
    );
    if (!client) {
      this.logger.warn(
        `${ctx.platform}: integration ${ctx.integration.id} has no usable token`,
      );
      return;
    }

    try {
      // Acknowledge a tap first: an unanswered callback leaves a spinner on
      // the button for as long as the flow takes.
      if (ctx.callbackQueryId) {
        await client.answerCallbackQuery(ctx.callbackQueryId);
      }

      const result = await this.router.route(ctx);

      // The password message goes as soon as it has been used. Both platforms
      // allow this in a private chat for 48 h (see `capabilities.ts`); when it
      // fails, the user is told rather than left thinking it is gone.
      let deletionFailed = false;
      if (result.deleteIncoming && ctx.messageId !== undefined) {
        deletionFailed = capabilitiesOf(ctx.platform).deleteIncomingMessage
          ? !(await client.deleteMessage(ctx.chatId, ctx.messageId))
          : true;
      }

      // A result may switch languages mid-update (the language chooser), and
      // the switch has to apply to the reply that announces it.
      const lang = result.lang ?? ctx.lang;
      const t = this.copy.translator(lang);
      const rendered = this.renderer.render(ctx.platform, result.view, t);
      const text = deletionFailed
        ? `${this.copy.text(lang, { key: 'bot.register.passwordKept' })}\n\n${rendered.text}`
        : rendered.text;

      await client.sendMessage(ctx.chatId, text, rendered.replyMarkup);

      if (result.nextState) {
        await this.nav.save(ctx.integration, ctx.chatId, {
          ...result.nextState,
          lastView: result.view,
        });
      } else {
        await this.nav.clear(ctx.integration, ctx.chatId);
      }
    } catch (e: unknown) {
      this.logger.error(
        `${ctx.platform}: handling chat=${ctx.chatId} failed: ${
          e instanceof Error ? (e.stack ?? e.message) : String(e)
        }`,
      );
      try {
        await client.sendMessage(
          ctx.chatId,
          this.copy.text(ctx.lang, { key: 'bot.common.tryAgain' }),
        );
      } catch {
        // The messenger itself is unreachable; the log line above is all there is.
      }
    }
  }
}
