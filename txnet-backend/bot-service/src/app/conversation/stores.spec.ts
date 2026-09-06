import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
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

    await store.save('telegram', '5501', state);

    const written = redis.values.get('bot:nav:telegram:5501') as NavState;
    expect(written.data).toEqual({ phoneNumber: '09121112233' });
  });

  it('keeps the navigation state it is given', async () => {
    const redis = fakeRedis();
    const store = new ConversationStore(redis as unknown as RedisService, config);

    await store.save('bale', '77', { flow: 'login', step: 'login.code', data: {} });

    expect(await store.get('bale', '77')).toMatchObject({ step: 'login.code' });
    await store.clear('bale', '77');
    expect(await store.get('bale', '77')).toBeNull();
  });
});

describe('BotSessionStore', () => {
  it('pushes the idle expiry out on every read', async () => {
    const redis = fakeRedis();
    const store = new BotSessionStore(redis as unknown as RedisService, config);
    await store.save('telegram', '5501', 'r-1');

    const session = await store.get('telegram', '5501');

    expect(session?.refreshToken).toBe('r-1');
    expect(redis.touch).toHaveBeenCalledWith('bot:session:telegram:5501', expect.any(Number));
  });

  it('reports a chat with no entry as signed out', async () => {
    // A chat id is not an authentication: without this entry, it is anonymous.
    const redis = fakeRedis();
    const store = new BotSessionStore(redis as unknown as RedisService, config);

    expect(await store.get('telegram', 'unknown-chat')).toBeNull();
    expect(redis.touch).not.toHaveBeenCalled();
  });
});
