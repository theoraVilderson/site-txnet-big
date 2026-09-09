import { ConfigService } from '@nestjs/config';
import { aBotIntegration } from '@txnet-backend/messenger';
import { RedisKeys, RedisTtl } from './redis.keys';
import { RedisService } from './redis.service';

/**
 * The twin of `auth-service`'s key catalogue snapshot, and for the same
 * reason: a key that changes shape does not fail, it silently stops finding
 * data that is already there. Here that reads as "every signed-in chat was
 * signed out" (`bot:session:*`) or "every conversation lost its place"
 * (`bot:nav:*`) — with no error anywhere to say why.
 *
 * `bot-service` writes into the same keyspace `auth-service` does, so a change
 * here has to be a diff a human approves, not a green run.
 */
const telegram = aBotIntegration({ id: 'integration-1' });
const bale = aBotIntegration({ id: 'integration-2', platform: 'bale' });

describe('RedisKeys — bot key catalogue', () => {
  it('builds every key from fixed arguments', () => {
    const built = {
      botNav: RedisKeys.botNav(telegram, '5501'),
      botSession: RedisKeys.botSession(telegram, '5501'),
      botLang: RedisKeys.botLang(bale, '77'),
    };

    expect(built).toMatchSnapshot();
  });

  it('exposes a builder for every key family, and nothing unbuilt', () => {
    expect(Object.keys(RedisKeys).sort()).toMatchSnapshot();
  });

  it('keeps the canonical TTLs stable', () => {
    expect(RedisTtl).toMatchSnapshot();
  });

  it('keeps the two platforms in separate keyspaces', () => {
    // ADR-0015: the platforms number their chats independently, so a chat id
    // alone can name two different chats. A key that dropped the platform
    // would hand one person's session to another.
    expect(RedisKeys.botSession(telegram, '5501')).not.toBe(
      RedisKeys.botSession(bale, '5501'),
    );
  });

  it('keeps two bots on one platform in separate keyspaces (F-320)', () => {
    // The same argument one level down, and the one multi-tenancy turns on:
    // two resellers' Telegram bots see the same chat id for the same person.
    // The integration is the door the update came through, so it is what
    // separates them — the platform on its own no longer can.
    const other = aBotIntegration({ id: 'integration-9', tenantId: 'globex' });

    for (const key of [RedisKeys.botNav, RedisKeys.botSession, RedisKeys.botLang]) {
      expect(key(telegram, '5501')).not.toBe(key(other, '5501'));
    }
  });

  it('keeps a language preference alive longer than the session that set it', () => {
    // The comment in redis.keys.ts is the rule: a preference that expires
    // with the conversation is a preference the user re-sets every time.
    expect(RedisTtl.botLang).toBeGreaterThan(RedisTtl.botSession);
    expect(RedisTtl.botSession).toBeGreaterThan(RedisTtl.botNav);
  });
});

describe('RedisService.keyPrefix — parity with auth-service', () => {
  const prefixFor = (env: Record<string, string>) => {
    const config = {
      get: <T>(key: string, fallback?: T) =>
        (env[key] as unknown as T) ?? fallback,
    } as unknown as ConfigService;
    return new RedisService(config).keyPrefix;
  };

  const base = { REDIS_URL: 'redis://127.0.0.1:6379' };

  it('lands in the same namespace auth-service writes to', () => {
    // Both services address the same Redis; a bot session written under a
    // different prefix is a session auth-service's tooling cannot see.
    expect(prefixFor(base)).toBe('txnet:auth:v1:');
    expect(prefixFor(base) + RedisKeys.botSession(telegram, '5501')).toBe(
      'txnet:auth:v1:bot:session:telegram:integration-1:5501',
    );
  });

  it('bumping the keyspace version moves every bot key at once', () => {
    expect(
      prefixFor({ ...base, REDIS_KEYSPACE_VERSION: 'v2' }) +
        RedisKeys.botNav(telegram, '5501'),
    ).toBe('txnet:auth:v2:bot:nav:telegram:integration-1:5501');
  });
});
