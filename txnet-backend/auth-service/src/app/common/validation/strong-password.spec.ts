import {
  assertPasswordNotContainingProfile,
  PasswordContainsProfileDataError,
  strongPasswordSchema,
} from './strong-password.schema';

describe('strong-password.schema', () => {
  describe('strongPasswordSchema', () => {
    it.each(['Aa1!aaaa', 'Str0ng#Password', 'P@ssw0rd', 'aA1_bbbb', 'aA1 bbbb'])(
      'accepts %p',
      (password) => {
        expect(strongPasswordSchema.safeParse(password).success).toBe(true);
      },
    );

    it.each([
      ['too short', 'Aa1!aaa', 'password.tooShort'],
      ['no lowercase', 'AA1!AAAA', 'password.needsLowercase'],
      ['no uppercase', 'aa1!aaaa', 'password.needsUppercase'],
      ['no digit', 'aA!aaaaa', 'password.needsDigit'],
      ['no special char', 'aA1aaaaa', 'password.needsSpecialChar'],
      ['empty', '', 'password.tooShort'],
    ])('rejects %s with %p', (_label, password, key) => {
      const result = strongPasswordSchema.safeParse(password);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((i) => i.message)).toContain(key);
      }
    });

    it('enforces the 72-char bcrypt-safe ceiling', () => {
      const body = 'aA1!'.repeat(18); // exactly 72
      expect(body).toHaveLength(72);
      expect(strongPasswordSchema.safeParse(body).success).toBe(true);

      const tooLong = body + 'x';
      const result = strongPasswordSchema.safeParse(tooLong);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((i) => i.message)).toContain(
          'password.tooLong',
        );
      }
    });

    it('every failure message is an i18n key, never a human sentence', () => {
      const result = strongPasswordSchema.safeParse('a');
      expect(result.success).toBe(false);
      if (!result.success) {
        for (const issue of result.error.issues) {
          expect(issue.message).toMatch(/^password\.[a-zA-Z]+$/);
        }
      }
    });
  });

  describe('assertPasswordNotContainingProfile', () => {
    const profile = {
      username: 'alireza',
      fullName: 'Ali Rezaei',
      phoneNumber: '09121234567',
    };

    it('passes when the password shares nothing with the profile', () => {
      expect(() =>
        assertPasswordNotContainingProfile('Xk7#quiet-Owl', profile),
      ).not.toThrow();
    });

    it.each([
      ['username', 'alireza'],
      ['fullName', 'Ali Rezaei'],
      ['phoneNumber', '09121234567'],
    ])('throws when the password embeds the %s', (_field, value) => {
      expect(() =>
        assertPasswordNotContainingProfile(`prefix-${value}-suffix`, profile),
      ).toThrow(PasswordContainsProfileDataError);
    });

    it('throws the typed error carrying the i18n key, not a raw message', () => {
      try {
        assertPasswordNotContainingProfile('MyAlirezaPass1!', profile);
        throw new Error('expected assertPasswordNotContainingProfile to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(PasswordContainsProfileDataError);
        expect((e as PasswordContainsProfileDataError).i18nKey).toBe(
          'password.containsProfileData',
        );
      }
    });

    describe('case-insensitivity — both sides are lowered', () => {
      it.each([
        ['password upper, profile lower', 'ALIREZA!1', { username: 'alireza' }],
        ['password lower, profile upper', 'alireza!1', { username: 'ALIREZA' }],
        ['mixed on both sides', 'AliReZa!1', { username: 'aLiReZA' }],
        ['turkish-ish casing stays byte-simple', 'ALI!1aaa', { username: 'ali' }],
      ])('%s', (_label, password, partial) => {
        expect(() =>
          assertPasswordNotContainingProfile(password, partial),
        ).toThrow(PasswordContainsProfileDataError);
      });
    });

    describe('short candidates are skipped (length >= 3 filter)', () => {
      it.each([
        ['1-char username', 'a'],
        ['2-char username', 'al'],
      ])('%s never triggers, even when present in the password', (_l, username) => {
        expect(() =>
          assertPasswordNotContainingProfile('Xk7#quiet-Owl-al-a', { username }),
        ).not.toThrow();
      });

      it('a 3-char candidate is the first length that triggers', () => {
        expect(() =>
          assertPasswordNotContainingProfile('Xk7#ali-Owl', { username: 'al' }),
        ).not.toThrow();
        expect(() =>
          assertPasswordNotContainingProfile('Xk7#ali-Owl', { username: 'ali' }),
        ).toThrow(PasswordContainsProfileDataError);
      });
    });

    describe('the check is whole-candidate containment, not token overlap', () => {
      // Documented gap: only the FULL candidate string is searched for. A
      // password built from one word of a multi-word fullName, or from the
      // phone number without its leading zero, passes today. If this ever
      // becomes a real policy requirement, these three expectations invert.
      it('does not catch a single word of a multi-word fullName', () => {
        expect(() =>
          assertPasswordNotContainingProfile('Rezaei#2024', {
            fullName: 'Ali Rezaei',
          }),
        ).not.toThrow();
      });

      it('does not catch the phone number without its leading zero', () => {
        expect(() =>
          assertPasswordNotContainingProfile('Pass#9121234567', {
            phoneNumber: '09121234567',
          }),
        ).not.toThrow();
      });

      it('does not catch a candidate broken up by a separator', () => {
        expect(() =>
          assertPasswordNotContainingProfile('ali-reza#1A', {
            username: 'alireza',
          }),
        ).not.toThrow();
      });
    });

    describe('absent profile fields', () => {
      it.each([
        ['empty object', {}],
        ['all null', { username: null, fullName: null, phoneNumber: null }],
        [
          'all undefined',
          { username: undefined, fullName: undefined, phoneNumber: undefined },
        ],
        ['empty strings', { username: '', fullName: '', phoneNumber: '' }],
      ])('%s is a no-op', (_label, partial) => {
        expect(() =>
          assertPasswordNotContainingProfile('Aa1!aaaa', partial),
        ).not.toThrow();
      });

      it('checks the fields that are present when others are missing', () => {
        expect(() =>
          assertPasswordNotContainingProfile('xxalirezaxx', {
            username: 'alireza',
            fullName: null,
          }),
        ).toThrow(PasswordContainsProfileDataError);
      });
    });

    it('returns void on success', () => {
      expect(
        assertPasswordNotContainingProfile('Xk7#quiet-Owl', profile),
      ).toBeUndefined();
    });
  });
});
