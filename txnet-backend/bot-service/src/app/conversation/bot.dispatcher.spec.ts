import {
  BotClientRegistry,
  BotViewRenderer,
  MESSENGER_CAPABILITIES,
} from '@txnet-backend/messenger';
import { BotCopy } from '../locale/bot-copy';
import { ConversationStore } from './conversation.store';
import { ChatLanguage } from '../locale/chat-language';
import { BotDispatcher } from './bot.dispatcher';
import { ConversationRouter } from './router';
import { ChatContext, FlowResult } from './nav.types';

const ctx: ChatContext = {
  platform: 'telegram',
  chatId: '5501',
  lang: 'fa',
  text: 'Str0ng!pass',
  messageId: 77,
};

function harness(result: FlowResult) {
  const client = {
    sendMessage: jest.fn().mockResolvedValue(1),
    deleteMessage: jest.fn().mockResolvedValue(true),
    answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
  };
  const bots = { client: () => client } as unknown as BotClientRegistry;
  const router = { route: jest.fn().mockResolvedValue(result) } as unknown as ConversationRouter;
  const nav = { save: jest.fn(), clear: jest.fn() } as unknown as ConversationStore;
  const copy = {
    translator: () => (t: { key?: string; raw?: string }) => t.raw ?? t.key ?? '',
    text: (_l: string, t: { key?: string }) => t.key ?? '',
  } as unknown as BotCopy;

  return {
    client,
    nav,
    dispatcher: new BotDispatcher(
      router,
      nav,
      new BotViewRenderer(),
      copy,
      // The chat has never chosen a language: the messenger's hint stands.
      {
        resolve: async (_p: unknown, _c: unknown, hint: string) => hint,
      } as unknown as ChatLanguage,
      bots,
    ),
  };
}

const view = { id: 'otp.code', body: { key: 'bot.login.askCode' } };

describe('BotDispatcher', () => {
  afterEach(() => {
    MESSENGER_CAPABILITIES.telegram = {
      ...MESSENGER_CAPABILITIES.telegram,
      deleteIncomingMessage: true,
    };
  });

  it('deletes the password message before answering', async () => {
    const { dispatcher, client } = harness({ view, nextState: null, deleteIncoming: true });

    await dispatcher.handle(ctx);

    expect(client.deleteMessage).toHaveBeenCalledWith('5501', 77);
    expect(client.sendMessage).toHaveBeenCalledWith('5501', 'bot.login.askCode', undefined);
  });

  it('tells the user to delete it themselves when the platform will not', async () => {
    // A password left in a chat history is the failure this step exists to
    // avoid; silence would leave the user believing it is gone.
    MESSENGER_CAPABILITIES.telegram = {
      ...MESSENGER_CAPABILITIES.telegram,
      deleteIncomingMessage: false,
    };
    const { dispatcher, client } = harness({ view, nextState: null, deleteIncoming: true });

    await dispatcher.handle(ctx);

    expect(client.deleteMessage).not.toHaveBeenCalled();
    expect(client.sendMessage.mock.calls[0][1]).toContain('bot.register.passwordKept');
  });

  it('says the same thing when the delete call itself fails', async () => {
    const { dispatcher, client } = harness({ view, nextState: null, deleteIncoming: true });
    client.deleteMessage.mockResolvedValue(false);

    await dispatcher.handle(ctx);

    expect(client.sendMessage.mock.calls[0][1]).toContain('bot.register.passwordKept');
  });

  it('never deletes a message the flow did not ask it to', async () => {
    const { dispatcher, client } = harness({ view, nextState: null });

    await dispatcher.handle({ ...ctx, text: '123456' });

    expect(client.deleteMessage).not.toHaveBeenCalled();
  });

  it('remembers the screen it showed, so a typed answer can be matched later', async () => {
    const state = { flow: 'login' as const, step: 'login.code', data: {} };
    const { dispatcher, nav } = harness({ view, nextState: state });

    await dispatcher.handle(ctx);

    expect(nav.save).toHaveBeenCalledWith(
      'telegram',
      '5501',
      expect.objectContaining({ step: 'login.code', lastView: view }),
    );
  });

  it('clears the conversation when the flow ended', async () => {
    const { dispatcher, nav } = harness({ view, nextState: null });

    await dispatcher.handle(ctx);

    expect(nav.clear).toHaveBeenCalledWith('telegram', '5501');
  });

  it('answers a tap before doing the work, so no button is left spinning', async () => {
    const { dispatcher, client } = harness({ view, nextState: null });

    await dispatcher.handle({ ...ctx, callbackQueryId: 'cb-1' });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith('cb-1');
  });

  it('tells the user something went wrong rather than letting the update redeliver', async () => {
    const { dispatcher, client } = harness({ view, nextState: null });
    (dispatcher as unknown as { router: { route: jest.Mock } }).router.route.mockRejectedValue(
      new Error('boom'),
    );

    await expect(dispatcher.handle(ctx)).resolves.toBeUndefined();
    expect(client.sendMessage).toHaveBeenCalledWith('5501', 'bot.common.tryAgain');
  });
});
