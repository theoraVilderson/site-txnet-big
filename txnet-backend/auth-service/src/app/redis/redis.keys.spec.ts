import {
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  buildRedisKeyPrefix,
} from '@txnet-backend/shared-core';
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
      rateLimitPlatform: RedisKeys.rateLimitPlatform('login:1.2.3.4'),
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

  it('keeps the platform-wide bucket free of any tenant', () => {
    // F-066-s: the counter that caps one caller across every tenant it can
    // name. `platform` sits where a tenant id sits and no tenant id can equal
    // it, so the bucket is unreachable from inside a tenant — the same
    // argument that makes `none` safe for an unresolved request.
    expect(
      runWithTenant(TENANT, () => RedisKeys.rateLimitPlatform('login:ip')),
    ).toBe('ratelimit:platform:login:ip');
    expect(RedisKeys.rateLimitPlatform('login:ip')).toBe(
      'ratelimit:platform:login:ip',
    );
  });

  it('keeps a session key tenant-free, so auth-handler still finds it', () => {
    // `auth-handler` builds `session:<id>` in Go from the same prefix and has
    // no tenant of its own (redis-keyspace/contract.md). A tenant segment here
    // would make every gateway lookup miss, and a miss is read as "revoked".
    expect(RedisKeys.session('sess-1')).toBe('session:sess-1');
    expect(RedisKeys.userSessions('user-1')).toBe('user:user-1:sessions');
  });

  /**
   * F-076 merged the four per-app catalogues into
   * `shared-core/src/lib/redis/keys.ts`, so this service now *sees* families it
   * does not use — `tenantRuns` is `worker-service`'s, the `bot*` TTLs are
   * `bot-service`'s. The snapshot therefore lists more than the one above
   * builds, and "every family is exercised somewhere" moved with the catalogue
   * to `shared-core/src/lib/redis/keys.spec.ts`.
   *
   * What this snapshot still proves is the thing that matters here: nothing was
   * **removed or renamed** by the merge. A key that changes shape does not
   * fail, it silently stops finding data that is already there.
   */
  it('exposes a builder for every key family, and nothing unbuilt', () => {
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

  it('defaults to the one declared keyspace', () => {
    // The value itself lives in `contracts/redis/keyspace.json`, not here — a
    // second copy of it is exactly how the defaults drifted apart (ADR-0036).
    expect(prefixFor(base)).toBe(
      buildRedisKeyPrefix(
        REDIS_KEY_NAMESPACE_DEFAULT,
        REDIS_KEYSPACE_VERSION_DEFAULT,
      ),
    );
  });

  it('produces the on-the-wire key auth-handler reads back', () => {
    // handler.go: h.keyPrefix + "session:" + claims.SessionID
    expect(prefixFor(base) + RedisKeys.session('sess-1')).toBe(
      `${buildRedisKeyPrefix()}session:sess-1`,
    );
  });

  it('bumping the keyspace version moves every key at once', () => {
    // What the version is *for*: one change abandons the whole keyspace, which
    // is a forced logout of everybody (C-03).
    const current = prefixFor(base) + RedisKeys.session('sess-1');
    const bumped =
      prefixFor({ ...base, REDIS_KEYSPACE_VERSION: 'v99' }) +
      RedisKeys.session('sess-1');

    expect(bumped).not.toBe(current);
    expect(bumped).toBe('txnet:auth:v99:session:sess-1');
  });

  /**
   * The Go side is `config.buildRedisKeyPrefix`, and the two must agree
   * exactly or the gateway looks up sessions nobody wrote: every request 401s
   * with `session_revoked` while the sessions sit there under a slightly
   * different name.
   *
   * **That parity is no longer tested here**, and deliberately. This file used
   * to hold a TypeScript transcription of the Go function and compare it with
   * the Node implementation — which tested that two TypeScript functions
   * agreed, and could never have caught the Go side drifting. ADR-0036
   * replaced it with `contracts/redis/keyspace.json` plus a test in each
   * language: `shared-core/src/lib/redis/keyspace.contract.spec.ts` and
   * `auth-handler/internal/config/keyspace_contract_test.go`.
   *
   * What is still this file's job is the chain in between: the env schema
   * normalises, and `RedisService` hands the result to the shared builder.
   */
  it('normalises a namespace written with a trailing colon', () => {
    // A trailing colon that only one language strips splits the keyspace in
    // two, which reads as every session having been revoked. Both the schema
    // and the builder strip it now, so the typo is harmless either way in.
    expect(envSchema.shape.REDIS_KEY_NAMESPACE.parse('txnet:auth:')).toBe(
      'txnet:auth',
    );
    expect(prefixFor({ ...base, REDIS_KEY_NAMESPACE: 'txnet:auth:' })).toBe(
      buildRedisKeyPrefix('txnet:auth', REDIS_KEYSPACE_VERSION_DEFAULT),
    );
  });

  it('takes its default namespace from the same declaration Go does', () => {
    expect(envSchema.shape.REDIS_KEY_NAMESPACE.parse(undefined)).toBe(
      REDIS_KEY_NAMESPACE_DEFAULT,
    );
  });
});
