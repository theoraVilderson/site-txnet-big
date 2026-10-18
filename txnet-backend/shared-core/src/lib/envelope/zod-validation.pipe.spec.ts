import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '@txnet-backend/shared-core';
import { sanitizeError } from './sanitize-error';

/**
 * The one request-body pipe every Nest service uses (CS-1-l; it was six
 * copies, one per app). A registration form stands in for any schema: keyed
 * messages, a transform, an unknown field.
 */
const registerSchema = z.object({
  fullName: z.string().min(2, 'fullName.tooShort'),
  username: z.string().min(3, 'username.tooShort').regex(/^[a-z0-9_]+$/, 'username.invalidChars'),
  phoneNumber: z
    .string()
    .regex(/^(\+98|0)?9\d{9}$/, 'phone.invalidFormat')
    .transform((p) => `+98${p.slice(-10)}`),
  password: z.string().min(8, 'password.tooShort'),
});

const validRegistration = {
  fullName: 'Ada Lovelace',
  username: 'ada_l',
  phoneNumber: '+989120000000',
  password: 'Str0ng!passw0rd',
};

/** The thrown body, typed the way the exception filter consumes it. */
function bodyOf(run: () => unknown): {
  i18nKey: string;
  fieldErrors: Array<{ path: string; i18nKey: string }>;
} {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as never;
  }
  throw new Error('expected the pipe to reject');
}

describe('ZodValidationPipe', () => {
  describe('valid input', () => {
    const pipe = new ZodValidationPipe(registerSchema);

    it('returns the parsed value, not the raw one', () => {
      expect(pipe.transform(validRegistration)).toMatchObject({
        username: 'ada_l',
      });
    });

    // The schema's own transforms have to survive the pipe, or every caller
    // downstream sees the un-normalized form the client happened to send.
    it('keeps the schema transform: a national number becomes E.164', () => {
      const parsed = pipe.transform(validRegistration) as {
        phoneNumber: string;
      };

      expect(parsed.phoneNumber).toBe('+989120000000');
    });

    it('strips a field the schema does not declare', () => {
      const parsed = pipe.transform({ ...validRegistration, isAdmin: true });

      expect(parsed).not.toHaveProperty('isAdmin');
    });
  });

  describe('the rejection body', () => {
    const pipe = new ZodValidationPipe(registerSchema);

    it('is a 400 carrying the validation.failed key', () => {
      const body = bodyOf(() =>
        pipe.transform({ ...validRegistration, username: 'a' }),
      );

      expect(body.i18nKey).toBe('validation.failed');
    });

    it('reports the failing field and the schema message as its i18n key', () => {
      const body = bodyOf(() =>
        pipe.transform({ ...validRegistration, username: 'a' }),
      );

      expect(body.fieldErrors).toEqual([
        { path: 'username', i18nKey: 'username.tooShort' },
      ]);
    });

    it.each([
      ['username', 'a', 'username.tooShort'],
      ['username', 'ada lovelace', 'username.invalidChars'],
      ['fullName', 'A', 'fullName.tooShort'],
      ['phoneNumber', '12345', 'phone.invalidFormat'],
    ])('maps a bad %s to %s -> %s', (field, value, key) => {
      const body = bodyOf(() =>
        pipe.transform({ ...validRegistration, [field]: value }),
      );

      expect(body.fieldErrors).toContainEqual({ path: field, i18nKey: key });
    });

    // A form shows every error at once; reporting only the first would make
    // the user resubmit once per mistake.
    it('reports every failing field, not just the first', () => {
      const body = bodyOf(() =>
        pipe.transform({ fullName: 'A', username: 'a', phoneNumber: 'x', password: 'weak' }),
      );

      const failed = [...new Set(body.fieldErrors.map((f) => f.path))].sort();

      expect(failed).toEqual([
        'fullName',
        'password',
        'phoneNumber',
        'username',
      ]);
    });

    it('joins a nested path with dots', () => {
      const nested = new ZodValidationPipe(
        z.object({ profile: z.object({ city: z.string().min(2, 'city.tooShort') }) }),
      );

      const body = bodyOf(() => nested.transform({ profile: { city: 'x' } }));

      expect(body.fieldErrors).toEqual([
        { path: 'profile.city', i18nKey: 'city.tooShort' },
      ]);
    });

    it('addresses an array element by index', () => {
      const list = new ZodValidationPipe(
        z.object({ tags: z.array(z.string().min(2, 'tag.tooShort')) }),
      );

      const body = bodyOf(() => list.transform({ tags: ['ok', 'x'] }));

      expect(body.fieldErrors).toEqual([
        { path: 'tags.1', i18nKey: 'tag.tooShort' },
      ]);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not-an-object'],
      ['an array', []],
    ])('rejects %s as the whole body without throwing a TypeError', (_label, value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    });
  });

  // A schema rule written without a message carries Zod's English default.
  // The client must never see that prose, but it must still learn which field
  // failed: the pipe answers it with a generic key, so the path survives
  // sanitizeError (PK-1-j, CS-1-l).
  describe('a schema rule with no i18n message', () => {
    const pipe = new ZodValidationPipe(z.object({ email: z.string() }));

    it('answers the Zod default with validation.invalidValue', () => {
      const body = bodyOf(() => pipe.transform({}));

      expect(body.fieldErrors).toEqual([{ path: 'email', i18nKey: 'validation.invalidValue' }]);
    });

    it('keeps the path through sanitizeError, and never the prose', () => {
      let thrown: unknown;
      try {
        pipe.transform({});
      } catch (error) {
        thrown = error;
      }

      const safe = sanitizeError(thrown);

      expect(safe.status).toBe(400);
      expect(safe.msgKey).toBe('validation.failed');
      expect(safe.fieldErrors).toEqual([{ path: 'email', i18nKey: 'validation.invalidValue' }]);
    });
  });
});
