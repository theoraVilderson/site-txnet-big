import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { I18nExceptionFilter } from './i18n-exception.filter';
import { LocaleService } from '../../locale/locale.service';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { fakeArgumentsHost } from '../../../test-support/execution-context';
import { sanitizeError } from '../security/sanitize-error';

/** Only the `errors` namespace is served, and only these keys are translated. */
const catalog: Record<string, Record<string, string>> = {
  fa: {
    'auth.alreadyAuthenticated': 'شما already وارد شده‌اید',
    'permissions.forbidden': 'دسترسی ندارید',
    'system.unexpected': 'خطای غیرمنتظره',
    'system.conflict': 'تداخل داده',
    'validation.failed': 'ورودی نامعتبر است',
    'username.tooShort': 'نام کاربری کوتاه است',
  },
  en: {
    'auth.alreadyAuthenticated': 'You are already signed in',
    'system.unexpected': 'Unexpected error',
    'validation.failed': 'Invalid input',
    'username.tooShort': 'Username is too short',
  },
};

function localeStub() {
  return {
    getKey: jest.fn(
      (lang: string, namespace: string, key: string) =>
        namespace === 'errors' ? catalog[lang]?.[key] : undefined,
    ),
    getDefaultLanguage: jest.fn(() => 'fa'),
  };
}

describe('I18nExceptionFilter', () => {
  let locale: ReturnType<typeof localeStub>;
  let filter: I18nExceptionFilter;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    locale = localeStub();
    filter = new I18nExceptionFilter(locale as unknown as LocaleService);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('the response envelope', () => {
    it('is { ok: false, msg, ref } with the translated message', () => {
      const { host, response } = fakeArgumentsHost({ language: 'fa' });

      filter.catch(new ConflictException('auth.alreadyAuthenticated'), host);

      expect(response.statusCode()).toBe(409);
      expect(response.body()).toEqual({
        ok: false,
        msg: 'شما already وارد شده‌اید',
        ref: expect.stringMatching(/^[0-9a-f]{10}$/),
      });
    });

    it('translates into the language the middleware put on the request', () => {
      const { host, response } = fakeArgumentsHost({ language: 'en' });

      filter.catch(new ConflictException('auth.alreadyAuthenticated'), host);

      expect(response.body()?.msg).toBe('You are already signed in');
      expect(locale.getKey).toHaveBeenCalledWith(
        'en',
        'errors',
        'auth.alreadyAuthenticated',
      );
    });

    it('falls back to the default language when the request carries none', () => {
      const { host } = fakeArgumentsHost();

      filter.catch(new ConflictException('auth.alreadyAuthenticated'), host);

      expect(locale.getKey).toHaveBeenCalledWith('fa', 'errors', expect.any(String));
    });

    // A key with no translation yet must still produce a usable response —
    // the key itself — rather than an empty `msg`.
    it('sends the key itself when the catalog has no entry for it', () => {
      const { host, response } = fakeArgumentsHost({ language: 'fa' });

      filter.catch(new HttpException({ i18nKey: 'captcha.required' }, 400), host);

      expect(response.body()?.msg).toBe('captcha.required');
    });

    it('gives every response its own ref', () => {
      const first = fakeArgumentsHost();
      const second = fakeArgumentsHost();

      filter.catch(new ForbiddenException(), first.host);
      filter.catch(new ForbiddenException(), second.host);

      expect(first.response.body()?.ref).not.toBe(second.response.body()?.ref);
    });
  });

  describe('guard rejections reach the client as their own key', () => {
    it.each([
      ['NoActiveSessionGuard', new ConflictException('auth.alreadyAuthenticated'), 409, 'auth.alreadyAuthenticated'],
      ['CaptchaGuard', new HttpException({ i18nKey: 'captcha.required' }, 400), 400, 'captcha.required'],
    ])('%s', (_label, exception, status, key) => {
      const { host, response } = fakeArgumentsHost({ language: 'fa' });

      filter.catch(exception, host);

      expect(response.statusCode()).toBe(status);
      expect(locale.getKey).toHaveBeenCalledWith('fa', 'errors', key);
    });

    // These two throw prose, not keys. The sanitizer replaces it with the
    // generic key for the status, so the client gets a translated message
    // either way — this is the contract that lets those guards stay as they are.
    it.each([
      ['PermissionsGuard', new ForbiddenException('Insufficient permissions'), 403, 'permissions.forbidden'],
      ['RateLimitGuard', new HttpException('Too Many Requests', 429), 429, 'system.rateLimit'],
      ['AuthGuard', new UnauthorizedException('session revoked'), 401, 'auth.authorizationRequired'],
    ])('%s prose becomes the generic key for its status', (_label, exception, status, key) => {
      const { host, response } = fakeArgumentsHost({ language: 'fa' });

      filter.catch(exception, host);

      expect(response.statusCode()).toBe(status);
      expect(locale.getKey).toHaveBeenCalledWith('fa', 'errors', key);
      expect(JSON.stringify(response.body())).not.toContain('Insufficient');
    });
  });

  describe('validation errors', () => {
    const reject = () => {
      try {
        new ZodValidationPipe(
          z.object({ username: z.string().min(3, 'username.tooShort') }),
        ).transform({ username: 'a' });
      } catch (thrown) {
        return thrown;
      }
      throw new Error('expected the pipe to reject');
    };

    it('translate the message and every field entry', () => {
      const { host, response } = fakeArgumentsHost({ language: 'fa' });

      filter.catch(reject(), host);

      expect(response.body()).toMatchObject({
        ok: false,
        msg: 'ورودی نامعتبر است',
        fieldErrors: [{ path: 'username', message: 'نام کاربری کوتاه است' }],
      });
    });

    it('omits fieldErrors entirely when there are none', () => {
      const { host, response } = fakeArgumentsHost();

      filter.catch(new BadRequestException({ i18nKey: 'validation.failed' }), host);

      expect(response.body()).not.toHaveProperty('fieldErrors');
    });
  });

  describe('anything that is not an HttpException', () => {
    it.each([
      ['a plain bug', new TypeError("Cannot read properties of undefined (reading 'id')")],
      ['a thrown string', 'boom'],
      ['a rejected non-error', { code: 'ECONNREFUSED', address: '10.0.0.7' }],
    ])('%s becomes an opaque 500', (_label, thrown) => {
      const { host, response } = fakeArgumentsHost({ language: 'fa' });

      filter.catch(thrown, host);

      expect(response.statusCode()).toBe(500);
      expect(response.body()?.msg).toBe('خطای غیرمنتظره');
    });

    it('never lets the internal detail into the response body', () => {
      const { host, response } = fakeArgumentsHost();

      filter.catch(new Error('connect ECONNREFUSED postgres:5432'), host);

      expect(JSON.stringify(response.body())).not.toMatch(/ECONNREFUSED|postgres/);
    });

    // Duck-typed the way sanitizeError recognizes it — the spec must not need
    // the generated Prisma client. Which key and status a Prisma code maps to
    // is `sanitize-error.spec.ts`'s job, exhaustively; the filter's job is only
    // to translate whatever key it was handed, and to leak nothing on the way.
    it('translates the key sanitizeError returns for a Prisma error', () => {
      const prismaError = Object.assign(new Error('Unique constraint failed'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
        meta: { target: ['users_phone_number_key'] },
      });
      const { status, msgKey } = sanitizeError(prismaError);
      const { host, response } = fakeArgumentsHost({ language: 'fa' });

      filter.catch(prismaError, host);

      expect(response.statusCode()).toBe(status);
      expect(response.body()?.msg).toBe(catalog.fa[msgKey]);
      expect(JSON.stringify(response.body())).not.toMatch(/P2002|users_phone/);
    });
  });

  describe('the server log', () => {
    it('records a 4xx at warn and a 5xx at error', () => {
      filter.catch(new ForbiddenException(), fakeArgumentsHost().host);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();

      filter.catch(new Error('boom'), fakeArgumentsHost().host);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('correlates the log line with the ref the client was given', () => {
      const { host, response } = fakeArgumentsHost({
        method: 'POST',
        url: '/api/auth/login',
      });

      filter.catch(new Error('connect ECONNREFUSED postgres:5432'), host);

      const line = error.mock.calls[0][0] as string;
      expect(line).toContain(String(response.body()?.ref));
      expect(line).toContain('POST /api/auth/login');
      // The detail the client is denied has to be here instead.
      expect(line).toContain('ECONNREFUSED');
    });
  });
});
