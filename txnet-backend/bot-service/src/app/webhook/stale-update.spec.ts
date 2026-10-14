import { ConfigService } from '@nestjs/config';
import { BotClientRegistry, BotIntegration, TelegramLikeBotClient } from '@txnet-backend/messenger';
import { BotDispatcher } from '../conversation/bot.dispatcher';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';
import { ChatLanguage } from '../locale/chat-language';
import { RedisService } from '../redis/redis.service';
import { BotDispatchController } from './bot-dispatch.controller';
import { StaleUpdateNotice } from './stale-update';

/**
 * OPS-1-s, hosting H19 — **a bot update older than ten minutes is not run.**
 * After an outage the queue drains a backlog of taps and messages the user has
 * long since given up on; running them sends ten screens at once, in an order
 * the user no longer remembers. The chat is told once that the bot was briefly
 * unavailable instead, and a payment is never held back by its age.
 */
describe('a stale bot update', () => {
  const NOW = new Date('2026-10-14T12:00:00.000Z');
  const ELEVEN_MIN_AGO = new Date(NOW.getTime() - 11 * 60_000).toISOString();
  const integration = { id: 'integration-1', platform: 'telegram' } as BotIntegration;

  function setup() {
    const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const client = { answerCallbackQuery, sendMessage } as unknown as TelegramLikeBotClient;
    const handle = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();
    const redis = {
      setIfAbsent: vi.fn((key: string) => Promise.resolve(!seen.has(key) && Boolean(seen.add(key)))),
    } as unknown as RedisService;
    const bots = {
      byWebhookPath: vi.fn().mockResolvedValue(integration),
      client: vi.fn().mockResolvedValue(client),
    } as unknown as BotClientRegistry;
    const notice = new StaleUpdateNotice(
      bots,
      redis,
      { text: (_lang: string, t: { key: string }) => `[${t.key}]` } as unknown as BotCopy,
      { resolve: vi.fn().mockResolvedValue('en') } as unknown as ChatLanguage,
      { getOrThrow: () => 600_000 } as unknown as ConfigService,
    );
    const controller = new BotDispatchController(bots, { handle } as unknown as BotDispatcher, notice);
    return { controller, handle, answerCallbackQuery, sendMessage };
  }

  const update = (extra: Record<string, unknown>) => ({
    platform: 'telegram',
    webhookPath: 'path-1',
    chatId: '5501',
    lang: 'en',
    ...extra,
  });

  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('answers a stale tap with the notice and does not run the flow', async () => {
    const s = setup();
    const res = await s.controller.dispatch(
      update({ callbackData: 'menu:plans', callbackQueryId: 'cb-1', receivedAt: ELEVEN_MIN_AGO }),
    );

    expect(res).toEqual({ dispatched: true, stale: true });
    expect(s.handle).not.toHaveBeenCalled();
    expect(s.answerCallbackQuery).toHaveBeenCalledWith('cb-1', `[${BotKeys.common.staleUpdate}]`);
  });

  it('tells a chat once, however many stale messages it sent', async () => {
    const s = setup();
    await s.controller.dispatch(update({ text: '/start', receivedAt: ELEVEN_MIN_AGO }));
    await s.controller.dispatch(update({ text: 'hello?', receivedAt: ELEVEN_MIN_AGO }));

    expect(s.handle).not.toHaveBeenCalled();
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
    expect(s.sendMessage).toHaveBeenCalledWith('5501', `[${BotKeys.common.staleUpdate}]`);
  });

  it('runs an update with no receivedAt — one published before the deploy', async () => {
    const s = setup();
    expect(await s.controller.dispatch(update({ text: '/start' }))).toEqual({ dispatched: true });
    expect(s.handle).toHaveBeenCalledTimes(1);
  });

  it('runs a stale payment: money is relayed whatever its age', async () => {
    const s = setup();
    const payment = {
      kind: 'payment_succeeded',
      chatId: '5501',
      fromId: '5501',
      currency: 'XTR',
      totalAmount: 100,
      payload: 'pay-1',
      platformChargeId: 'charge-1',
      providerChargeId: null,
    };
    await s.controller.dispatch(update({ payment, receivedAt: ELEVEN_MIN_AGO }));
    expect(s.handle).toHaveBeenCalledTimes(1);
  });
});
