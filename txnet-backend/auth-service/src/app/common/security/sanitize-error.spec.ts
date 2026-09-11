import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sanitizeError, SanitizedError } from './sanitize-error';

/**
 * The security contract of this file: whatever is thrown, the parts of the
 * result that reach a client (`status`, `msgKey`, `fieldErrors`, `ref`) must
 * carry nothing but i18n keys. Every leak-shaped string — table names, Prisma
 * codes, SQL, stack frames, connection strings — belongs in `detail`, which is
 * server-log only.
 */

/** Everything that is actually serialized to the client. */
const outward = (s: SanitizedError) =>
  JSON.stringify({
    status: s.status,
    msgKey: s.msgKey,
    fieldErrors: s.fieldErrors,
    ref: s.ref,
  });

/** A duck-typed Prisma error — the real client is not imported by design. */
class FakePrismaError extends Error {
  constructor(
    name: string,
    readonly code?: string,
    readonly meta?: unknown,
  ) {
    super(`\nInvalid \`prisma.user.create()\` invocation in /app/src/user.ts:42`);
    this.name = name;
  }
}

describe('sanitizeError', () => {
  describe('never leaks internals', () => {
    const leaky = [
      new Error(
        'connect ECONNREFUSED 10.0.0.5:5432 postgresql://admin:hunter2@db/txnet',
      ),
      new Error('duplicate key value violates unique constraint "User_email_key"'),
      new Error('SELECT * FROM "identity"."User" WHERE email = $1'),
      new FakePrismaError('PrismaClientKnownRequestError', 'P2002', {
        target: ['email'],
        modelName: 'User',
      }),
      new TypeError("Cannot read properties of undefined (reading 'tenantId')"),
      'raw string thrown from a third-party lib',
      { message: 'plain object with a message field' },
    ];

    it.each(leaky.map((e, i) => [i, e]))(
      'case %i: outward payload contains no internal detail',
      (_i, thrown) => {
        const result = sanitizeError(thrown);
        const payload = outward(result);

        for (const secret of [
          'ECONNREFUSED',
          'hunter2',
          'postgresql',
          '5432',
          'User_email_key',
          'SELECT',
          'FROM',
          'identity',
          'tenantId',
          'P2002',
          'prisma',
          'Prisma',
          '/app/src',
          'third-party',
          'plain object',
        ]) {
          expect(payload).not.toContain(secret);
        }
      },
    );

    it('outward msgKey always satisfies the i18n key shape', () => {
      for (const thrown of [
        ...leaky,
        new UnauthorizedException(),
        new BadRequestException('validation failed for field email'),
        new HttpException('a message with spaces', 418),
        new HttpException({ message: { nested: 'object' } }, 400),
        null,
        undefined,
        42,
      ]) {
        const { msgKey } = sanitizeError(thrown);
        expect(msgKey).toMatch(/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+){1,5}$/);
        expect(msgKey.length).toBeLessThanOrEqual(64);
      }
    });

    it('keeps the real detail for the server log, correlated by ref', () => {
      const result = sanitizeError(
        new Error('duplicate key value violates unique constraint "User_email_key"'),
      );
      expect(result.detail).toContain('User_email_key');
      expect(result.detail).toContain('Error:');
      expect(result.detail).not.toBe('');
      expect(result.msgKey).toBe('system.unexpected');
    });

    it('never lets a stack trace reach msgKey', () => {
      const e = new Error('boom');
      e.stack = 'Error: boom\n    at Object.<anonymous> (/app/src/secret.ts:1:1)';
      const result = sanitizeError(e);
      expect(result.msgKey).toBe('system.unexpected');
      expect(result.detail).toContain('/app/src/secret.ts');
    });
  });

  describe('KEY_RE — what counts as a deliberate i18n key', () => {
    const forwarded = (candidate: unknown) =>
      sanitizeError(new HttpException(candidate as never, 400)).msgKey;

    it.each([
      'auth.invalidCredentials',
      'system.badRequest',
      'a.b',
      'phone.invalid_format',
      'a.b.c.d.e.f', // 5 separators — the maximum
      'x9.y0_1',
    ])('forwards %p', (key) => {
      expect(forwarded({ i18nKey: key })).toBe(key);
    });

    it.each([
      ['no dot at all', 'auth'],
      ['six separators', 'a.b.c.d.e.f.g'],
      ['leading dot', '.auth.x'],
      ['trailing dot', 'auth.x.'],
      ['starts with a digit', '1auth.x'],
      ['underscore in the first segment', 'auth_x.y'],
      ['contains a space', 'auth. x'],
      ['a human sentence', 'The user could not be found'],
      ['sql', 'SELECT * FROM users'],
      ['a path', 'src/app/auth.service.ts'],
      ['a dashed key', 'auth-x.y'],
      ['empty string', ''],
      ['double dot', 'auth..x'],
      ['over 64 chars', `a.${'b'.repeat(70)}`],
    ])('rejects %s (%p) and falls back to the status key', (_label, value) => {
      expect(forwarded({ i18nKey: value })).toBe('system.badRequest');
    });

    it.each([null, undefined, 42, true, ['auth.x'], { nested: 'auth.x' }])(
      'rejects the non-string candidate %p',
      (value) => {
        expect(forwarded({ i18nKey: value })).toBe('system.badRequest');
      },
    );

    it('accepts a key of exactly 64 chars and rejects 65', () => {
      const at64 = `a.${'b'.repeat(62)}`;
      expect(at64).toHaveLength(64);
      expect(forwarded({ i18nKey: at64 })).toBe(at64);

      const at65 = `a.${'b'.repeat(63)}`;
      expect(at65).toHaveLength(65);
      expect(forwarded({ i18nKey: at65 })).toBe('system.badRequest');
    });
  });

  describe('HttpException', () => {
    it('forwards a bare string response that is a key', () => {
      const result = sanitizeError(new HttpException('auth.invalidCredentials', 401));
      expect(result).toMatchObject({
        status: 401,
        msgKey: 'auth.invalidCredentials',
        logLevel: 'warn',
      });
    });

    it('replaces a bare string response that is a sentence', () => {
      const result = sanitizeError(new HttpException('Invalid credentials', 401));
      expect(result.msgKey).toBe('auth.authorizationRequired');
    });

    it('prefers body.i18nKey over body.message', () => {
      const result = sanitizeError(
        new BadRequestException({
          i18nKey: 'phone.invalidFormat',
          message: 'phone must match /^09/',
        }),
      );
      expect(result.msgKey).toBe('phone.invalidFormat');
    });

    it('falls back to body.message only when it is itself a key', () => {
      expect(sanitizeError(new BadRequestException('otp.expired')).msgKey).toBe(
        'otp.expired',
      );
      expect(
        sanitizeError(new BadRequestException(['a is required', 'b is required']))
          .msgKey,
      ).toBe('system.badRequest');
    });

    it.each([
      [new BadRequestException(), HttpStatus.BAD_REQUEST, 'system.badRequest'],
      [new UnauthorizedException(), HttpStatus.UNAUTHORIZED, 'auth.authorizationRequired'],
      [new ForbiddenException(), HttpStatus.FORBIDDEN, 'permissions.forbidden'],
      [new NotFoundException(), HttpStatus.NOT_FOUND, 'system.notFound'],
      [new ConflictException(), HttpStatus.CONFLICT, 'system.conflict'],
      [
        new HttpException('nope', HttpStatus.TOO_MANY_REQUESTS),
        HttpStatus.TOO_MANY_REQUESTS,
        'system.rateLimit',
      ],
      [
        new ServiceUnavailableException(),
        HttpStatus.SERVICE_UNAVAILABLE,
        'system.unavailable',
      ],
      [
        new InternalServerErrorException(),
        HttpStatus.INTERNAL_SERVER_ERROR,
        'system.unexpected',
      ],
    ])('maps status %#: -> %s / %s', (exception, status, msgKey) => {
      const result = sanitizeError(exception);
      expect(result.status).toBe(status);
      expect(result.msgKey).toBe(msgKey);
    });

    it.each([
      ['unmapped 4xx -> badRequest', 418, 'system.badRequest'],
      ['unmapped 5xx -> unexpected', 502, 'system.unexpected'],
    ])('%s', (_label, status, msgKey) => {
      expect(sanitizeError(new HttpException('teapot', status)).msgKey).toBe(msgKey);
    });

    it.each([
      [400, 'warn'],
      [401, 'warn'],
      [499, 'warn'],
      [500, 'error'],
      [503, 'error'],
    ])('status %i logs at %s', (status, logLevel) => {
      expect(sanitizeError(new HttpException('x', status)).logLevel).toBe(logLevel);
    });
  });

  describe('fieldErrors from the validation pipe', () => {
    const withFields = (fieldErrors: unknown[], i18nKey?: unknown) =>
      sanitizeError(
        new BadRequestException({ i18nKey, fieldErrors } as never),
      );

    it('keeps entries whose i18nKey is a key, drops the rest', () => {
      const result = withFields(
        [
          { path: 'phoneNumber', i18nKey: 'phone.invalidFormat' },
          { path: 'password', i18nKey: 'password.tooShort' },
          { path: 'email', i18nKey: 'duplicate key value violates constraint' },
          { path: 'x', i18nKey: null },
          { path: 'y' },
          'not an object',
        ],
        'system.validationFailed',
      );

      expect(result.status).toBe(400);
      expect(result.msgKey).toBe('system.validationFailed');
      expect(result.fieldErrors).toEqual([
        { path: 'phoneNumber', i18nKey: 'phone.invalidFormat' },
        { path: 'password', i18nKey: 'password.tooShort' },
      ]);
    });

    it('defaults msgKey to system.validationFailed when the body key is unsafe', () => {
      const result = withFields(
        [{ path: 'a', i18nKey: 'a.b' }],
        'Validation failed (3 errors)',
      );
      expect(result.msgKey).toBe('system.validationFailed');
    });

    it('coerces a missing path to an empty string rather than leaking undefined', () => {
      const result = withFields([{ i18nKey: 'a.b' }]);
      expect(result.fieldErrors).toEqual([{ path: '', i18nKey: 'a.b' }]);
    });

    it('returns an empty array when every entry is unsafe', () => {
      const result = withFields([{ path: 'a', i18nKey: 'boom boom' }]);
      expect(result.fieldErrors).toEqual([]);
    });

    it('ignores a non-array fieldErrors and takes the plain-body path', () => {
      const result = sanitizeError(
        new BadRequestException({
          i18nKey: 'auth.x',
          fieldErrors: 'not an array',
        } as never),
      );
      expect(result.msgKey).toBe('auth.x');
      expect(result.fieldErrors).toBeUndefined();
    });
  });

  describe('Prisma errors (duck-typed, no client import)', () => {
    it.each([
      ['P2002 unique constraint', 'P2002', 409, 'system.conflict', 'warn'],
      ['P2003 foreign key', 'P2003', 409, 'system.conflict', 'warn'],
      ['P2025 not found', 'P2025', 404, 'system.notFound', 'warn'],
      ['P2000 value too long', 'P2000', 400, 'system.badRequest', 'warn'],
      ['P1000 auth failed', 'P1000', 503, 'system.unavailable', 'error'],
      ['P1001 unreachable db', 'P1001', 503, 'system.unavailable', 'error'],
      ['P1002 db timeout', 'P1002', 503, 'system.unavailable', 'error'],
      ['P1008 operation timeout', 'P1008', 503, 'system.unavailable', 'error'],
      ['P1017 connection closed', 'P1017', 503, 'system.unavailable', 'error'],
      ['unknown code', 'P9999', 500, 'system.unexpected', 'error'],
    ])('%s', (_label, code, status, msgKey, logLevel) => {
      const result = sanitizeError(
        new FakePrismaError('PrismaClientKnownRequestError', code, {
          target: ['email'],
        }),
      );
      expect(result).toMatchObject({ status, msgKey, logLevel });
      expect(outward(result)).not.toContain(code);
    });

    it('PrismaClientInitializationError is a 503, not a 500', () => {
      const result = sanitizeError(
        new FakePrismaError('PrismaClientInitializationError'),
      );
      expect(result).toMatchObject({
        status: 503,
        msgKey: 'system.unavailable',
        logLevel: 'error',
      });
      // A start-up failure carries the datasource URL — it must stay in detail.
      expect(result.detail).toContain('PrismaClientInitializationError');
      expect(outward(result)).not.toContain('PrismaClientInitializationError');
    });

    it.each([
      'PrismaClientValidationError',
      'PrismaClientRustPanicError',
      'PrismaClientUnknownRequestError',
    ])('%s is an opaque 500', (name) => {
      expect(sanitizeError(new FakePrismaError(name))).toMatchObject({
        status: 500,
        msgKey: 'system.unexpected',
        logLevel: 'error',
      });
    });

    it('a known-request error without a string code is not treated as Prisma', () => {
      const e = new FakePrismaError('PrismaClientKnownRequestError');
      expect(sanitizeError(e)).toMatchObject({
        status: 500,
        msgKey: 'system.unexpected',
      });
    });

    it('logs the Prisma code so the operator can still debug it', () => {
      const result = sanitizeError(
        new FakePrismaError('PrismaClientKnownRequestError', 'P2002'),
      );
      expect(result.detail).toContain('code=P2002');
    });
  });

  describe('anything else', () => {
    it.each([
      ['a plain Error', new Error('boom')],
      ['a TypeError', new TypeError('boom')],
      ['a string', 'boom'],
      ['a number', 42],
      ['null', null],
      ['undefined', undefined],
      ['a plain object', { a: 1 }],
      ['an array', [1, 2, 3]],
      ['a symbol-free class instance', new (class Foo {})()],
    ])('%s becomes an opaque 500', (_label, thrown) => {
      expect(sanitizeError(thrown)).toMatchObject({
        status: 500,
        msgKey: 'system.unexpected',
        logLevel: 'error',
      });
    });

    it('survives a circular structure that JSON.stringify cannot handle', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      const result = sanitizeError(circular);
      expect(result.msgKey).toBe('system.unexpected');
      expect(result.detail).toContain('non-error thrown');
    });

    it('survives a throwing toJSON', () => {
      const nasty = {
        toJSON() {
          throw new Error('nope');
        },
      };
      expect(() => sanitizeError(nasty)).not.toThrow();
      expect(sanitizeError(nasty).msgKey).toBe('system.unexpected');
    });

    it('truncates a huge Error detail to 4000 chars', () => {
      const result = sanitizeError(new Error('x'.repeat(20_000)));
      expect(result.detail).toHaveLength(4000);
    });

    it('truncates a huge non-Error detail to 2000 chars', () => {
      const result = sanitizeError({ blob: 'x'.repeat(20_000) });
      expect(result.detail).toHaveLength(2000);
    });
  });

  describe('ref', () => {
    it('is 10 lowercase hex chars', () => {
      expect(sanitizeError(new Error('boom')).ref).toMatch(/^[0-9a-f]{10}$/);
    });

    it('is different on every call, so two log lines are never confused', () => {
      const refs = new Set(
        Array.from({ length: 200 }, () => sanitizeError(new Error('boom')).ref),
      );
      expect(refs.size).toBe(200);
    });

    it('is present on every branch', () => {
      for (const thrown of [
        new BadRequestException({ fieldErrors: [] }),
        new NotFoundException(),
        new FakePrismaError('PrismaClientKnownRequestError', 'P2002'),
        'raw',
      ]) {
        expect(sanitizeError(thrown).ref).toMatch(/^[0-9a-f]{10}$/);
      }
    });
  });
});

/**
 * F-081. The generic keys this file answers with are also the ones
 * `auth-handler` answers with in Go, and both languages used to spell them by
 * hand against one JSON file. Both now import generated constants — but those
 * are two generated files, from two generators. This is the check that they
 * describe the same catalogue, for the keys the two services actually share.
 */
describe('the errors catalogue both languages are generated from', () => {
  const goFile = readFileSync(
    join(__dirname, '../../../../../../auth-handler/internal/i18nkeys/keys_generated.go'),
    'utf8',
  );
  const goConst = (name: string): string | undefined =>
    new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(goFile)?.[1];

  it.each([
    ['ErrorsAuthAuthorizationRequired', BackendI18nKeys.errors.auth.authorizationRequired],
    ['ErrorsAuthInvalidToken', BackendI18nKeys.errors.auth.invalidToken],
    ['ErrorsAuthSessionRevoked', BackendI18nKeys.errors.auth.sessionRevoked],
    ['ErrorsPermissionsForbidden', BackendI18nKeys.errors.permissions.forbidden],
    ['ErrorsSystemUnexpected', BackendI18nKeys.errors.system.unexpected],
    ['ErrorsSystemUnavailable', BackendI18nKeys.errors.system.unavailable],
  ])('Go %s is the same key TypeScript sends', (goName, tsKey) => {
    expect(goConst(goName)).toBe(tsKey);
  });

  it('answers only with keys that exist in the catalogue', () => {
    // A generic key that is not in `errors.json` reaches the user untranslated,
    // as the raw key — which is the failure every constant here prevents.
    const known = new Set<string>(Object.values(BackendI18nKeys.errors.system));
    for (const status of [400, 401, 403, 404, 409, 429, 500, 502, 503]) {
      const { msgKey } = sanitizeError(new HttpException('x', status));
      const [group] = msgKey.split('.');
      if (group === 'system') expect(known).toContain(msgKey);
    }
  });
});
