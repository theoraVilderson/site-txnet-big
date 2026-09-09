import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { aBotIntegration } from '@txnet-backend/messenger';
import { RedisKeys } from '../redis/redis.keys';
import { BotSessionStore } from '../session/bot-session.store';
import { ConversationStore } from './conversation.store';
import { NavState } from './nav.types';

function fakeRedis() {
  const values = new Map<string, unknown>();
  return {
    values,
    setJson: jest.fn(async (key: string, value: unknown) => void values.set(key, value)),
    getJson: jest.fn(async (key: string) => values.get(key) ?? null),
    del: jest.fn(async (key: string) => void values.delete(key)),
    touch: jest.fn(async () => undefined),
  };
}

const config = { get: (_k: string, d: number) => d } as unknown as ConfigService;

/** Two resellers' bots, and one person talking to both from the same chat. */
const acme = aBotIntegration({ id: 'acme-bot', tenantId: 'acme' });
const globex = aBotIntegration({ id: 'globex-bot', tenantId: 'globex' });
const bale = aBotIntegration({ id: 'acme-bale', platform: 'bale' });

describe('ConversationStore', () => {
  it('never writes a password, whatever the flow put in the state', async () => {
    // The flows spend a password inside one request; this is the guarantee
    // that a future step cannot quietly start persisting one (ADR-0011).
    const redis = fakeRedis();
    const store = new ConversationStore(redis as unknown as RedisService, config);
    const state = {
      flow: 'register',
      step: 'register.password',
      data: { phoneNumber: '09121112233', password: 'Str0ng!pass', newPassword: 'x' },
    } as unknown as NavState;

    await store.save(acme, '5501', state);

    const written = redis.values.get(RedisKeys.botNav(acme, '5501')) as NavState;
    expect(written.data).toEqual({ phoneNumber: '09121112233' });
  });

  it('keeps the navigation state it is given', async () => {
    const redis = fakeRedis();
    const store = new ConversationStore(redis as unknown as RedisService, config);

    await store.save(bale, '77', { flow: 'login', step: 'login.code', data: {} });

    expect(await store.get(bale, '77')).toMatchObject({ step: 'login.code' });
    await store.clear(bale, '77');
    expect(await store.get(bale, '77')).toBeNull();
  });

  it('keeps two tenants\u2019 bots apart on one chat id (F-320)', async () => {
    // The messenger issues the chat id, so the same person writing to two
    // resellers' Telegram bots is '5501' in both. Keyed by platform alone,
    // the second bot would resume the first one's half-typed registration.
    const redis = fakeRedis();
    const store = new ConversationStore(redis as unknown as RedisService, config);

    await store.save(acme, '5501', { flow: 'register', step: 'register.phone', data: {} });

    expect(await store.get(globex, '5501')).toBeNull();
    await store.clear(globex, '5501');
    expect(await store.get(acme, '5501')).toMatchObject({ step: 'register.phone' });
  });
});

describe('BotSessionStore', () => {
  it('pushes the idle expiry out on every read', async () => {
    const redis = fakeRedis();
    const store = new BotSessionStore(redis as unknown as RedisService, config);
    await store.save(acme, '5501', 'r-1');

    const session = await store.get(acme, '5501');

    expect(session?.refreshToken).toBe('r-1');
    expect(redis.touch).toHaveBeenCalledWith(
      RedisKeys.botSession(acme, '5501'),
      expect.any(Number),
    );
  });

  it('reports a chat with no entry as signed out', async () => {
    // A chat id is not an authentication: without this entry, it is anonymous.
    const redis = fakeRedis();
    const store = new BotSessionStore(redis as unknown as RedisService, config);

    expect(await store.get(acme, 'unknown-chat')).toBeNull();
    expect(redis.touch).not.toHaveBeenCalled();
  });

  it('never hands one tenant\u2019s refresh token to another tenant\u2019s bot (F-320)', async () => {
    // The sharpest form of the collision: a session is a credential, and a
    // chat id shared between two bots would have shared it.
    const redis = fakeRedis();
    const store = new BotSessionStore(redis as unknown as RedisService, config);

    await store.save(acme, '5501', 'r-acme');

    expect(await store.get(globex, '5501')).toBeNull();
    expect((await store.get(acme, '5501'))?.refreshToken).toBe('r-acme');
  });
});
