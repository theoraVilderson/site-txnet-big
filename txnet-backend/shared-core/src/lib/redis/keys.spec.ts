import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BotRedisKeys,
  UnscopedRedisKeys,
  createScopedRedisKeys,
} from './keys';
import type { RedisKeyScope } from './keys';

/**
 * The one key catalogue (F-076, ADR-0036, C-03).
 *
 * Three jobs, and the first is the one the row exists for.
 *
 * 1. **Every family is exercised.** Each of the four services used to have its
 *    own catalogue and its own snapshot, so a family was only ever checked by
 *    the service that happened to own it. `session:` was built in two of them
 *    and `otp:channel:` in two more, and nothing compared the spellings.
 * 2. **The cross-language families match Go.** `auth-handler` builds
 *    `session:` itself, and a disagreement is silent: the lookup misses, the
 *    miss is read as "revoked", and every request 401s while the sessions sit
 *    there under a slightly different name.
 * 3. **The scoped families refuse to build without a tenant.** That property
 *    lives in ADR-0024 and survived the move only because the scope is looked
 *    up per call rather than captured once at construction.
 */

const FIXTURE = join(__dirname, '../../../../../contracts/redis/keyspace.json');

interface KeyspaceFixture {
  keys: Record<string, string>;
  keyCases: Array<{ builder: string; id: string; key: string }>;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as KeyspaceFixture;

/** A scope that answers, for the families that need one. */
const scoped = createScopedRedisKeys({
  tenant: () => 'tenant-1',
  tenantOrNone: () => 'tenant-1',
});

/** A scope with no tenant, which is what an unresolved host produces. */
const unresolved = createScopedRedisKeys({
  tenant: (what: string) => {
    throw new Error(`no tenant in scope for ${what}`);
  },
  tenantOrNone: () => 'none',
});

describe('the key catalogue', () => {
  it('builds every unscoped family', () => {
    expect({
      session: UnscopedRedisKeys.session('sess-1'),
      userSessions: UnscopedRedisKeys.userSessions('user-1'),
      otpChannel: UnscopedRedisKeys.otpChannel('chan-1'),
      realtimeFanout: UnscopedRedisKeys.realtimeFanout('user:user-1'),
      rateLimitPlatform: UnscopedRedisKeys.rateLimitPlatform('login:1.2.3.4'),
      botLinkToken: UnscopedRedisKeys.botLinkToken('tok-1'),
      captchaChallenge: UnscopedRedisKeys.captchaChallenge('chal-1'),
      captchaVerified: UnscopedRedisKeys.captchaVerified('pass-1'),
      tenantByHost: UnscopedRedisKeys.tenantByHost('myvpn.com'),
      tenantById: UnscopedRedisKeys.tenantById('tenant-1'),
      tenantRuns: UnscopedRedisKeys.tenantRuns('tenant-1'),
    }).toMatchSnapshot();
  });

  it('builds every scoped family', () => {
    expect({
      otpCode: scoped.otpCode('login', '+989123456789'),
      otpLock: scoped.otpLock('login', '+989123456789'),
      otpCooldown: scoped.otpCooldown('login', '+989123456789'),
      otpDelivery: scoped.otpDelivery('del-1'),
      rateLimit: scoped.rateLimit('login:1.2.3.4'),
      registerPending: scoped.registerPending('+989123456789'),
      botLinkPhone: scoped.botLinkPhone('telegram', '+989123456789'),
      botLinkChat: scoped.botLinkChat('telegram', '55501'),
      botLinkProvenChat: scoped.botLinkProvenChat('telegram', '+989123456789'),
    }).toMatchSnapshot();
  });

  it('builds every bot family', () => {
    const integration = { platform: 'telegram', id: 'integration-1' };
    expect({
      botNav: BotRedisKeys.botNav(integration, '5501'),
      botSession: BotRedisKeys.botSession(integration, '5501'),
      botLang: BotRedisKeys.botLang(integration, '5501'),
    }).toMatchSnapshot();
  });

  it('leaves nothing in the catalogue unexercised', () => {
    // The direction a per-service snapshot could never cover: a family added
    // here without a line above would ship untested in all four services at
    // once.
    expect([
      ...Object.keys(UnscopedRedisKeys),
      ...Object.keys(scoped),
      ...Object.keys(BotRedisKeys),
    ].sort()).toMatchSnapshot();
  });

});

describe('the families auth-handler also builds', () => {
  const builders: Record<string, (id: string) => string> = {
    session: UnscopedRedisKeys.session,
    otpChannel: UnscopedRedisKeys.otpChannel,
    userSessions: UnscopedRedisKeys.userSessions,
  };

  it.each(fixture.keyCases)(
    'builds $key for $builder, the same string Go builds',
    ({ builder, id, key }) => {
      expect(builders[builder]).toBeDefined();
      expect(builders[builder]?.(id)).toBe(key);
    },
  );

  it('declares no cross-language family this file cannot build', () => {
    // The other direction: a name in the fixture with no builder here is a key
    // only Go knows how to make.
    expect(Object.keys(fixture.keys).filter((k) => k !== 'note').sort()).toEqual(
      Object.keys(builders).sort(),
    );
  });
});

describe('the scoped families and an absent tenant', () => {
  it('refuses to build a phone-derived key with no tenant in scope', () => {
    // ADR-0023: a phone number identifies a person within a tenant, so these
    // keys have no meaning outside one. An unscoped key is a cross-tenant
    // collision, and failing loudly is the only safe default.
    expect(() => unresolved.otpCode('login', '+989123456789')).toThrow();
    expect(() => unresolved.registerPending('+989123456789')).toThrow();
    expect(() => unresolved.botLinkChat('telegram', '55501')).toThrow();
  });

  it('still counts a rate-limit bucket when no tenant resolved', () => {
    // A request to a host matching no tenant is exactly what a flood looks
    // like. Throwing here would turn the guard's 404 into a 500 and hand an
    // attacker an uncounted door.
    expect(unresolved.rateLimit('login:1.2.3.4')).toBe(
      'ratelimit:none:login:1.2.3.4',
    );
  });

  it('looks the tenant up per call, not once at construction', () => {
    // The property ADR-0024 actually guarantees: a call site written later
    // cannot forget to scope one. Capturing the tenant when the builder is
    // created would quietly turn that into "whatever was in scope at boot".
    let current = 'tenant-a';
    const scope: RedisKeyScope = {
      tenant: () => current,
      tenantOrNone: () => current,
    };
    const keys = createScopedRedisKeys(scope);

    expect(keys.registerPending('+98912')).toBe(
      'register:pending:tenant-a:+98912',
    );
    current = 'tenant-b';
    expect(keys.registerPending('+98912')).toBe(
      'register:pending:tenant-b:+98912',
    );
  });
});
