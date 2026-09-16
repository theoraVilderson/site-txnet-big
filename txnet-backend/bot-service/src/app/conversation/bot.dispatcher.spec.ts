import type { Mock } from 'vitest';
import {
  BotClientRegistry,
  BotViewRenderer,
  MESSENGER_CAPABILITIES, aBotIntegration } from '@txnet-backend/messenger';
import { BotCopy } from '../locale/bot-copy';
import { ConversationStore } from './conversation.store';
import { ChatLanguage } from '../locale/chat-language';
import { BotDispatcher } from './bot.dispatcher';
import { ConversationRouter } from './router';
import { ChatContext, FlowResult } from './nav.types';

const ctx: ChatContext = {
  integration: aBotIntegration(),
  platform: 'telegram',
  chatId: '5501',
  lang: 'fa',
  text: 'Str0ng!pass',
  messageId: 77,
};

function harness(result: FlowResult) {
  const client = {
    sendMessage: vi.fn().mockResolvedValue(1),
    deleteMessage: vi.fn().mockResolvedValue(true),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    sendInvoice: vi.fn().mockResolvedValue({ ok: true, messageId: 2 }),
  };
  const payments = { handle: vi.fn().mockResolvedValue(undefined) };
  const bots = { client: () => client } as unknown as BotClientRegistry;
  const router = { route: vi.fn().mockResolvedValue(result) } as unknown as ConversationRouter;
  const nav = { save: vi.fn(), clear: vi.fn() } as unknown as ConversationStore;
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
      payments as never,
    ),
    payments,
    router,
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
      ctx.integration,
      '5501',
      expect.objectContaining({ step: 'login.code', lastView: view }),
    );
  });

  it('clears the conversation when the flow ended', async () => {
    const { dispatcher, nav } = harness({ view, nextState: null });

    await dispatcher.handle(ctx);

    expect(nav.clear).toHaveBeenCalledWith(ctx.integration, '5501');
  });

  it('answers a tap before doing the work, so no button is left spinning', async () => {
    const { dispatcher, client } = harness({ view, nextState: null });

    await dispatcher.handle({ ...ctx, callbackQueryId: 'cb-1' });

    expect(client.answerCallbackQuery).toHaveBeenCalledWith('cb-1');
  });

  it('tells the user something went wrong rather than letting the update redeliver', async () => {
    const { dispatcher, client } = harness({ view, nextState: null });
    (dispatcher as unknown as { router: { route: Mock } }).router.route.mockRejectedValue(
      new Error('boom'),
    );

    await expect(dispatcher.handle(ctx)).resolves.toBeUndefined();
    expect(client.sendMessage).toHaveBeenCalledWith('5501', 'bot.common.tryAgain');
  });

  it('sends a flow’s invoice after its screen, translated (F-104-m)', async () => {
    const { dispatcher, client } = harness({
      view: { id: 'topUp.payInChat', body: { key: 'bot.topUp.payInChat' } },
      nextState: null,
      invoice: {
        title: { key: 'bot.topUp.invoiceTitle' },
        description: { key: 'bot.topUp.invoiceDescription' },
        label: { key: 'bot.topUp.invoiceLabel' },
        payload: 'p-3',
        currency: 'XTR',
        amount: 770,
        providerToken: null,
      },
    });

    await dispatcher.handle({ ...ctx, text: undefined, messageId: undefined });

    expect(client.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(client.sendInvoice.mock.invocationCallOrder[0]);
    expect(client.sendInvoice).toHaveBeenCalledWith('5501', {
      title: 'bot.topUp.invoiceTitle',
      description: 'bot.topUp.invoiceDescription',
      payload: 'p-3',
      currency: 'XTR',
      prices: [{ label: 'bot.topUp.invoiceLabel', amount: 770 }],
    });
  });

  it('sends an invoice’s provider token with it, and none when billing answered none (F-104-n)', async () => {
    const { dispatcher, client } = harness({
      view: { id: 'topUp.payInChat', body: { key: 'bot.topUp.payInChat' } },
      nextState: null,
      invoice: {
        title: { key: 'bot.topUp.invoiceTitle' },
        description: { key: 'bot.topUp.invoiceDescription' },
        label: { key: 'bot.topUp.invoiceLabel' },
        payload: 'p-4',
        currency: 'IRR',
        amount: 20_200_000,
        providerToken: 'wallet-token',
      },
    });

    await dispatcher.handle({ ...ctx, platform: 'bale', text: undefined, messageId: undefined });

    expect(client.sendInvoice).toHaveBeenCalledWith('5501', expect.objectContaining({ currency: 'IRR', providerToken: 'wallet-token' }));
  });

  it('relays a payment event without routing it or touching the conversation (F-104-m)', async () => {
    const { dispatcher, client, payments, router, nav } = harness({ view, nextState: null });
    const payment = { kind: 'pre_checkout', queryId: 'q1', fromId: '5501', currency: 'XTR', totalAmount: 770, payload: 'p-3' } as const;

    await dispatcher.handle({ ...ctx, text: undefined, messageId: undefined, payment });

    expect(payments.handle).toHaveBeenCalledWith(expect.objectContaining({ payment }), client);
    expect(router.route).not.toHaveBeenCalled();
    expect(nav.clear).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
