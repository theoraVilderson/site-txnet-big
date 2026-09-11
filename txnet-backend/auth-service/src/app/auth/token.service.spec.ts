import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { AuthClaims, TokenService } from './token.service';

const ACCESS_SECRET = 'unit-test-access-secret';
const REFRESH_SECRET = 'unit-test-refresh-secret';

// Deliberately *not* the production defaults (900/300/300/1800). Every TTL
// assertion below reads these back, so a spec that passes proves the
// configured value was honoured — not that a constant inside the service is
// still the number someone typed there (F-054).
const TTL = {
  JWT_ACCESS_TTL_SEC: 111,
  OTP_TOKEN_TTL_SEC: 222,
  RESET_TOKEN_TTL_SEC: 333,
  IMPERSONATION_TOKEN_TTL_SEC: 444,
} as const;

function configStub(values: Record<string, unknown> = {}): ConfigService {
  const all: Record<string, unknown> = {
    JWT_ACCESS_SECRET: ACCESS_SECRET,
    JWT_REFRESH_HASH_SECRET: REFRESH_SECRET,
    ...TTL,
    ...values,
  };
  return {
    get: (key: string, fallback?: unknown) =>
      key in all ? all[key] : fallback,
  } as unknown as ConfigService;
}

const baseClaims: Omit<AuthClaims, 'iat' | 'exp'> = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  roleId: 'role-1',
  roleName: 'user',
  permissions: ['user.read'],
  sessionId: 'session-1',
};

const b64url = (value: string | object) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString(
    'base64url',
  );

/** Build a token by hand so the payload can be arbitrary while the signature stays valid. */
function forge(
  header: string,
  payload: string,
  secret = ACCESS_SECRET,
): string {
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const DEFAULT_HEADER = b64url({ alg: 'HS256', typ: 'JWT' });

describe('TokenService', () => {
  let tokens: TokenService;

  beforeEach(() => {
    tokens = new TokenService(configStub());
  });

  describe('constructor', () => {
    it('falls back to JWT_SECRET when JWT_ACCESS_SECRET is absent', () => {
      const service = new TokenService(
        configStub({ JWT_ACCESS_SECRET: undefined, JWT_SECRET: 'legacy' }),
      );
      const token = service.sign(baseClaims);
      expect(service.verify(token).sub).toBe('user-1');
    });

    it('throws when no signing secret is configured at all', () => {
      expect(
        () =>
          new TokenService(
            configStub({ JWT_ACCESS_SECRET: undefined, JWT_SECRET: undefined }),
          ),
      ).toThrow('JWT_ACCESS_SECRET is required');
    });
  });

  describe('sign / verify round trip', () => {
    it('returns the claims it was given, plus iat and exp', () => {
      const before = Math.floor(Date.now() / 1000);
      const claims = tokens.verify(tokens.sign(baseClaims));

      expect(claims).toMatchObject(baseClaims);
      expect(claims.iat).toBeGreaterThanOrEqual(before);
      expect(claims.exp).toBe(claims.iat + TTL.JWT_ACCESS_TTL_SEC);
    });

    it('honours an explicit TTL over JWT_ACCESS_TTL_SEC', () => {
      const claims = tokens.verify(tokens.sign(baseClaims, 60));
      expect(claims.exp - claims.iat).toBe(60);
    });

    it('reads JWT_ACCESS_TTL_SEC when no TTL is passed', () => {
      const service = new TokenService(configStub({ JWT_ACCESS_TTL_SEC: 120 }));
      const claims = service.verify(service.sign(baseClaims));
      expect(claims.exp - claims.iat).toBe(120);
    });

    // The service used to carry `config.get('JWT_ACCESS_TTL_SEC', 900)`, so an
    // unset TTL silently minted a 15-minute token. `envSchema` owns these
    // defaults; a missing one is a boot misconfiguration and must say so.
    it.each([
      ['sign', (s: TokenService) => s.sign(baseClaims), 'JWT_ACCESS_TTL_SEC'],
      ['signOtpToken', (s: TokenService) => s.signOtpToken('u'), 'OTP_TOKEN_TTL_SEC'],
      [
        'signResetToken',
        (s: TokenService) => s.signResetToken('+989120000000', 'u'),
        'RESET_TOKEN_TTL_SEC',
      ],
      [
        'signImpersonatedToken',
        (s: TokenService) => s.signImpersonatedToken({ id: 'u' }, 's', 'a'),
        'IMPERSONATION_TOKEN_TTL_SEC',
      ],
    ])('%s refuses to mint when its TTL is not configured', (_l, mint, key) => {
      const service = new TokenService(configStub({ [key]: undefined }));
      expect(() => mint(service)).toThrow(`${key} is required`);
    });

    it('emits a three-part token with an HS256 header', () => {
      const parts = tokens.sign(baseClaims).split('.');
      expect(parts).toHaveLength(3);
      expect(
        JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
      ).toEqual({ alg: 'HS256', typ: 'JWT' });
    });
  });

  describe('verify — malformed input', () => {
    it.each([
      ['empty string', ''],
      ['one part', 'onlyonepart'],
      ['two parts', `${DEFAULT_HEADER}.${b64url({ sub: 'x' })}`],
      ['four parts', `${DEFAULT_HEADER}.${b64url({ sub: 'x' })}.sig.extra`],
      ['only separators', '..'],
    ])('rejects a token with %s', (_label, token) => {
      expect(() => tokens.verify(token)).toThrow(UnauthorizedException);
    });
  });

  describe('verify — signature', () => {
    it('rejects a tampered signature of the same length', () => {
      const [header, payload, signature] = tokens.sign(baseClaims).split('.');
      const flipped =
        (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);

      expect(() => tokens.verify(`${header}.${payload}.${flipped}`)).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a tampered payload that was not re-signed', () => {
      const [header, , signature] = tokens.sign(baseClaims).split('.');
      const swapped = b64url({
        ...baseClaims,
        sub: 'attacker',
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 900,
      });

      expect(() => tokens.verify(`${header}.${swapped}.${signature}`)).toThrow(
        UnauthorizedException,
      );
    });

    // Regression: timingSafeEqual throws RangeError on unequal buffer lengths,
    // which would surface as a 500 instead of a 401.
    it.each([
      ['a truncated signature', (s: string) => s.slice(0, 10)],
      ['an empty signature', () => ''],
      ['an over-long signature', (s: string) => `${s}${s}`],
      ['a single character', () => 'x'],
    ])('rejects %s with 401, never a RangeError', (_label, mutate) => {
      const [header, payload, signature] = tokens.sign(baseClaims).split('.');
      const token = `${header}.${payload}.${mutate(signature)}`;

      expect(() => tokens.verify(token)).toThrow(UnauthorizedException);
      expect(() => tokens.verify(token)).not.toThrow(RangeError);
    });

    it('rejects a token signed with a different secret', () => {
      const other = new TokenService(
        configStub({ JWT_ACCESS_SECRET: 'someone-elses-secret' }),
      );

      expect(() => tokens.verify(other.sign(baseClaims))).toThrow(
        UnauthorizedException,
      );
    });

    it('does not accept an unsigned "alg: none" token', () => {
      const header = b64url({ alg: 'none', typ: 'JWT' });
      const payload = b64url({
        ...baseClaims,
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 900,
      });

      expect(() => tokens.verify(`${header}.${payload}.`)).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('verify — payload decoding', () => {
    it.each([
      ['characters outside the base64url alphabet', '@@@@'],
      ['valid base64 that is not JSON', b64url('definitely not json {')],
      ['an empty payload segment', ''],
      ['a truncated JSON object', b64url('{"sub":')],
    ])('rejects a correctly signed token whose payload is %s', (_l, payload) => {
      expect(() => tokens.verify(forge(DEFAULT_HEADER, payload))).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('verify — expiry', () => {
    it('rejects a token whose exp has passed', () => {
      expect(() => tokens.verify(tokens.sign(baseClaims, -1))).toThrow(
        'token expired',
      );
    });

    it('rejects a token whose exp is exactly now (exp is exclusive)', () => {
      expect(() => tokens.verify(tokens.sign(baseClaims, 0))).toThrow(
        'token expired',
      );
    });

    it('accepts a token one second before it expires', () => {
      expect(tokens.verify(tokens.sign(baseClaims, 1)).sub).toBe('user-1');
    });

    it('treats a payload with no exp at all as expired', () => {
      const payload = b64url({ sub: 'user-1', sessionId: 'session-1' });
      expect(() => tokens.verify(forge(DEFAULT_HEADER, payload))).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('purposed tokens', () => {
    it('marks OTP tokens with purpose=otp_login and no session', () => {
      const claims = tokens.verify(tokens.signOtpToken('user-1'));

      expect(claims.purpose).toBe('otp_login');
      expect(claims.sessionId).toBe('');
      expect(claims.permissions).toEqual([]);
      expect(claims.exp - claims.iat).toBe(TTL.OTP_TOKEN_TTL_SEC);
    });

    it('marks reset tokens with purpose=password_reset and no session', () => {
      const claims = tokens.verify(tokens.signResetToken('+989120000000', 'user-1'));

      expect(claims.purpose).toBe('password_reset');
      expect(claims.sessionId).toBe('');
      expect(claims.exp - claims.iat).toBe(TTL.RESET_TOKEN_TTL_SEC);
    });

    // `verify()` is deliberately purpose-agnostic: auth.service.ts calls it on
    // OTP and reset tokens and checks `purpose` itself afterwards. So it hands
    // the claims back with the purpose intact — the "must not pass as an
    // access token" rule is enforced at the access-token gate instead, and is
    // covered in auth.guard.spec.ts.
    it.each([
      ['an OTP token', () => tokens.signOtpToken('user-1'), 'otp_login'],
      [
        'a reset token',
        () => tokens.signResetToken('+989120000000', 'user-1'),
        'password_reset',
      ],
    ])(
      'decodes %s but keeps its purpose visible to callers',
      (_label, mint, purpose) => {
        expect(tokens.verify(mint()).purpose).toBe(purpose);
      },
    );

    it('leaves purpose undefined on a real access token', () => {
      expect(tokens.verify(tokens.sign(baseClaims)).purpose).toBeUndefined();
    });
  });

  describe('signAccessToken / signImpersonatedToken', () => {
    const user = {
      id: 'user-1',
      tenantId: 'tenant-1',
      roleId: 'role-1',
      role: {
        name: 'Admin',
        rolePermissions: [
          { permission: { key: 'user.read' } },
          { permission: { key: 'user.write' } },
        ],
      },
    };

    it('flattens role permissions onto the claims', () => {
      const claims = tokens.verify(tokens.signAccessToken(user, 'session-1'));
      expect(claims.permissions).toEqual(['user.read', 'user.write']);
    });

    it('defaults to no permissions when the role is not loaded', () => {
      const claims = tokens.verify(
        tokens.signAccessToken({ id: 'u', tenantId: 't', roleId: 'r' }, 's'),
      );
      expect(claims.permissions).toEqual([]);
    });

    // `forward-auth` keys `permissions.yaml` by role *name*. `roleId` is a
    // database UUID that differs on every seed, so a token carrying only the id
    // was refused 403 by the gateway on every request (ADR-0037).
    it.each([
      ['an access token', () => tokens.signAccessToken(user, 'session-1')],
      [
        'an impersonated token',
        () => tokens.signImpersonatedToken(user, 'session-1', 'admin-9'),
      ],
    ])('carries the role name beside the id on %s', (_label, mint) => {
      const claims = tokens.verify(mint());
      expect(claims.roleId).toBe('role-1');
      expect(claims.roleName).toBe('Admin');
    });

    it('signs an empty role name when the role is not loaded', () => {
      // Empty, not absent: the gateway reads it as a role no policy grants and
      // refuses, which is the same answer a missing claim must get.
      const claims = tokens.verify(
        tokens.signAccessToken({ id: 'u', tenantId: 't', roleId: 'r' }, 's'),
      );
      expect(claims.roleName).toBe('');
    });

    it('records who is impersonating whom', () => {
      const claims = tokens.verify(
        tokens.signImpersonatedToken(user, 'session-1', 'admin-9'),
      );

      expect(claims.sub).toBe('user-1');
      expect(claims.isImpersonated).toBe(true);
      expect(claims.impersonatedBy).toBe('admin-9');
      expect(claims.exp - claims.iat).toBe(TTL.IMPERSONATION_TOKEN_TTL_SEC);
    });
  });

  describe('refresh tokens', () => {
    it('hashes deterministically with the refresh secret', () => {
      const hash = tokens.refreshHash('some-refresh-token');

      expect(hash).toBe(tokens.refreshHash('some-refresh-token'));
      expect(hash).toBe(
        createHmac('sha256', REFRESH_SECRET)
          .update('some-refresh-token')
          .digest('hex'),
      );
    });

    it('falls back to the access secret when no refresh secret is set', () => {
      const service = new TokenService(
        configStub({ JWT_REFRESH_HASH_SECRET: undefined }),
      );

      expect(service.refreshHash('t')).toBe(
        createHmac('sha256', ACCESS_SECRET).update('t').digest('hex'),
      );
    });

    it('mints unguessable, unique refresh tokens', () => {
      const minted = new Set(
        Array.from({ length: 100 }, () => tokens.newRefreshToken()),
      );

      expect(minted.size).toBe(100);
      expect([...minted][0]).toMatch(/^[A-Za-z0-9_-]{86}$/);
    });
  });
});
