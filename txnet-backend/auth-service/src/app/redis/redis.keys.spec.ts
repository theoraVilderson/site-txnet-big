import { ConfigService } from '@nestjs/config';
import { envSchema } from '../config/env.validation';
import { RedisKeys, RedisTtl } from './redis.keys';
import { RedisService } from './redis.service';
import {
  TenantContextMissing,
  runWithTenant,
} from '../tenant-context/tenant-context';

const TENANT = { id: 'tenant-1', slug: 'reseller-a', via: 'domain' } as const;

/**
 * These strings are not an implementation detail: a live session, a pending
 * registration and an unspent captcha pass are all addressed by name, and a
 * key that changes shape does not fail — it silently stops finding the data
 * that is already there. For `session:*` that reads as "every logged-in user
 * was signed out"; for `otp:cooldown:*` it reads as "the OTP cooldown stopped
 * applying".
 *
 * So this file is deliberately a snapshot: any change to a key must show up as
 * a diff a human approves, not as a green test run. Updating the snapshot is
 * the moment to ask whether the keyspace version needs bumping too.
 */
describe('RedisKeys — key catalogue', () => {
  it('builds every key from fixed arguments', () => {
    const built = runWithTenant(TENANT, () => ({
      session: RedisKeys.session('sess-1'),
      userSessions: RedisKeys.userSessions('user-1'),
      otpCode: RedisKeys.otpCode('login', '09123456789'),
      otpLock: RedisKeys.otpLock('login', '09123456789'),
      otpCooldown: RedisKeys.otpCooldown('login', '09123456789'),
      rateLimit: RedisKeys.rateLimit('login:1.2.3.4'),
      registerPending: RedisKeys.registerPending('09123456789'),
      botLinkToken: RedisKeys.botLinkToken('tok-1'),
      botLinkPhone: RedisKeys.botLinkPhone('telegram', '09123456789'),
      botLinkChat: RedisKeys.botLinkChat('telegram', '55501'),
      botLinkProvenChat: RedisKeys.botLinkProvenChat(
        'telegram',
        '09123456789',
      ),
      captchaChallenge: RedisKeys.captchaChallenge('chal-1'),
      captchaVerified: RedisKeys.captchaVerified('pass-1'),
      tenantByHost: RedisKeys.tenantByHost('myvpn.com'),
      tenantById: RedisKeys.tenantById('tenant-1'),
    }));

    expect(built).toMatchSnapshot();
  });

  it('refuses to build a tenant-derived key with no tenant in scope', () => {
    // ADR-0023: a phone number identifies a person within a tenant, so these
    // keys have no meaning outside one. `botLinkChat` joined them with
    // F-066-l: a chat id is the messenger's and is the same in every
    // reseller's bot, so the pointer needs the tenant for the same reason. Returning an unscoped key would
    // put two resellers' codes for the same number in one slot — the failure
    // this row exists to remove — so the builder throws instead, the way
    // `withTenant` does for a query (tenant-context/contract.md rule 3).
    const phoneDerived = [
      () => RedisKeys.otpCode('login', '+989123456789'),
      () => RedisKeys.otpLock('login', '+989123456789'),
      () => RedisKeys.otpCooldown('login', '+989123456789'),
      () => RedisKeys.registerPending('+989123456789'),
      () => RedisKeys.botLinkPhone('telegram', '+989123456789'),
      () => RedisKeys.botLinkProvenChat('telegram', '+989123456789'),
      () => RedisKeys.botLinkChat('telegram', '55501'),
    ];

    for (const build of phoneDerived) {
      expect(build).toThrow(TenantContextMissing);
    }
  });

  it('keeps a session key tenant-free, so auth-handler still finds it', () => {
    // `auth-handler` builds `session:<id>` in Go from the same prefix and has
    // no tenant of its own (redis-keyspace/contract.md). A tenant segment here
    // would make every gateway lookup miss, and a miss is read as "revoked".
    expect(RedisKeys.session('sess-1')).toBe('session:sess-1');
    expect(RedisKeys.userSessions('user-1')).toBe('user:user-1:sessions');
  });

  it('exposes a builder for every key family, and nothing unbuilt', () => {
    // Guards the other direction: a key added to the catalogue without a
    // snapshot line above would otherwise ship untested.
    expect(Object.keys(RedisKeys).sort()).toMatchSnapshot();
  });

  it('keeps the canonical TTLs stable', () => {
    expect(RedisTtl).toMatchSnapshot();
  });

  it('never lets a pending registration expire before the OTP that unlocks it', () => {
    // identity/invariants.md #11: the `user` row is created by verify-phone
    // from the pending payload. If the payload outlives the code, a valid OTP
    // arrives with nothing left to register.
    expect(RedisTtl.registerPending).toBeGreaterThanOrEqual(RedisTtl.otpCode);
  });
});

describe('RedisService.keyPrefix — the namespace every key inherits', () => {
  const prefixFor = (env: Record<string, string>) => {
    const config = {
      get: <T>(key: string, fallback?: T) =>
        (env[key] as unknown as T) ?? fallback,
    } as unknown as ConfigService;
    return new RedisService(config).keyPrefix;
  };

  const base = { REDIS_URL: 'redis://127.0.0.1:6379' };

  it('defaults to the documented namespace and version', () => {
    expect(prefixFor(base)).toBe('txnet:auth:v1:');
  });

  it('produces the on-the-wire key auth-handler reads back', () => {
    // handler.go: h.keyPrefix + "session:" + claims.SessionID
    expect(prefixFor(base) + RedisKeys.session('sess-1')).toBe(
      'txnet:auth:v1:session:sess-1',
    );
  });

  it('bumping the keyspace version moves every key at once', () => {
    const v1 = prefixFor(base) + RedisKeys.session('sess-1');
    const v2 =
      prefixFor({ ...base, REDIS_KEYSPACE_VERSION: 'v2' }) +
      RedisKeys.session('sess-1');

    expect(v2).not.toBe(v1);
    expect(v2).toBe('txnet:auth:v2:session:sess-1');
  });

  /**
   * auth-handler builds the same prefix in Go (config.buildRedisKeyPrefix).
   * The two must agree exactly or the gateway looks up sessions nobody wrote:
   * every request would 401 with `session_revoked` while the sessions sit
   * there under a slightly different name.
   */
  describe('parity with auth-handler/internal/config/config.go', () => {
    /** A transcription of Go's buildRedisKeyPrefix, held next to its twin. */
    const goBuildRedisKeyPrefix = (namespace: string, version: string) =>
      namespace.replace(/:+$/, '') + ':' + version + ':';

    /**
     * Go normalises the raw environment value (TrimRight ':'); the Node side
     * normalises earlier, in `envSchema`, and `RedisService` sees only the
     * result. So parity is a property of the whole chain, and testing
     * `RedisService` on a raw value would be testing a state the service can
     * never actually be handed.
     */
    const nodePrefixFromEnv = (namespace: string, version: string) =>
      prefixFor({
        ...base,
        REDIS_KEY_NAMESPACE:
          envSchema.shape.REDIS_KEY_NAMESPACE.parse(namespace),
        REDIS_KEYSPACE_VERSION: version,
      });

    it.each([
      ['txnet:auth', 'v1'],
      ['txnet:auth', 'v2'],
      ['acme', 'v7'],
      // The shapes that would split the keyspace if only one side normalised.
      ['txnet:auth:', 'v1'],
      ['txnet:auth::', 'v1'],
    ])(
      'agrees for REDIS_KEY_NAMESPACE=%s REDIS_KEYSPACE_VERSION=%s',
      (namespace, version) => {
        expect(nodePrefixFromEnv(namespace, version)).toBe(
          goBuildRedisKeyPrefix(namespace, version),
        );
      },
    );

    it('is the env schema, not RedisService, that strips the trailing colon', () => {
      // Says where the invariant lives, so a later refactor that drops the
      // transform fails here with the reason attached rather than in
      // production as a mass logout.
      expect(envSchema.shape.REDIS_KEY_NAMESPACE.parse('txnet:auth:')).toBe(
        'txnet:auth',
      );
      expect(prefixFor({ ...base, REDIS_KEY_NAMESPACE: 'txnet:auth:' })).toBe(
        'txnet:auth::v1:',
      );
    });

    it('defaults on both sides are the same namespace', () => {
      expect(envSchema.shape.REDIS_KEY_NAMESPACE.parse(undefined)).toBe(
        'txnet:auth',
      );
      expect(prefixFor(base)).toBe(goBuildRedisKeyPrefix('txnet:auth', 'v1'));
    });
  });
});
