import {
  detectIdentifierType,
  iranPhoneSchema,
  isIranPhoneNumber,
  normalizeIranPhone,
} from './phone.schema';

/**
 * `normalizeIranPhone` is deliberately NOT a validator — it only rewrites a
 * prefix. Everything that must reject bad input goes through `iranPhoneSchema`
 * first. These tests pin that split so nobody "fixes" the normalizer by making
 * it throw, and so the exact phone/username boundary stays visible.
 */
describe('phone.schema', () => {
  describe('normalizeIranPhone — accepted formats', () => {
    it.each([
      ['bare national', '09121234567', '09121234567'],
      ['+98 prefix', '+989121234567', '09121234567'],
      ['0098 prefix', '00989121234567', '09121234567'],
    ])('%s -> 09xxxxxxxxx', (_label, input, expected) => {
      expect(normalizeIranPhone(input)).toBe(expected);
    });

    it('is idempotent on an already normalized number', () => {
      const once = normalizeIranPhone('+989121234567');
      expect(normalizeIranPhone(once)).toBe(once);
    });

    it('strips only the first prefix it matches, never twice', () => {
      // `00989121234567` must consume `0098`, not `0` then `098`.
      expect(normalizeIranPhone('00989121234567')).toBe('09121234567');
    });
  });

  describe('normalizeIranPhone — invalid input is rewritten, not rejected', () => {
    it.each([
      ['too short', '0912', '0912'],
      ['non-numeric', 'notaphone', '0notaphone'],
      ['persian digits are untouched', '۰۹۱۲۱۲۳۴۵۶۷', '0۰۹۱۲۱۲۳۴۵۶۷'],
      ['spaced number keeps the space', '0912 123 4567', '0912 123 4567'],
      ['dashed number keeps the dashes', '0912-123-4567', '0912-123-4567'],
      ['landline is happily normalized', '02112345678', '02112345678'],
      ['+98 on a non-mobile body', '+98123', '0123'],
      ['empty string', '', '0'],
    ])('%s', (_label, input, expected) => {
      expect(() => normalizeIranPhone(input)).not.toThrow();
      expect(normalizeIranPhone(input)).toBe(expected);
    });

    it('never returns a value missing the leading zero', () => {
      for (const input of ['', 'x', '+98', '0098', '0']) {
        expect(normalizeIranPhone(input).startsWith('0')).toBe(true);
      }
    });
  });

  describe('iranPhoneSchema — validation happens before normalization', () => {
    it.each(['09121234567', '+989121234567', '00989121234567'])(
      'accepts %s and yields the normalized form',
      (input) => {
        expect(iranPhoneSchema.parse(input)).toBe('09121234567');
      },
    );

    it.each([
      '0912123456', // 10 digits
      '091212345678', // 12 digits
      '08121234567', // second digit must be 9
      '9121234567', // no prefix at all
      '0912 123 4567',
      '0912-123-4567',
      '۰۹۱۲۱۲۳۴۵۶۷',
      '+9809121234567',
      ' 09121234567',
      '09121234567 ',
      '',
    ])('rejects %p with the phone.invalidFormat key', (input) => {
      const result = iranPhoneSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('phone.invalidFormat');
      }
    });

    it('rejects non-string input without running the transform', () => {
      expect(iranPhoneSchema.safeParse(989121234567).success).toBe(false);
      expect(iranPhoneSchema.safeParse(null).success).toBe(false);
      expect(iranPhoneSchema.safeParse(undefined).success).toBe(false);
    });
  });

  describe('detectIdentifierType — the phone/username boundary', () => {
    it.each([
      '09121234567',
      '09999999999',
      '09000000000',
      '+989121234567',
      '00989121234567',
    ])('%p is a phone', (input) => {
      expect(detectIdentifierType(input)).toBe('phone');
      expect(isIranPhoneNumber(input)).toBe(true);
    });

    it.each([
      ['one digit short', '0912123456'],
      ['one digit long', '091212345678'],
      ['second digit is not 9', '08121234567'],
      ['missing leading zero', '9121234567'],
      ['leading whitespace', ' 09121234567'],
      ['trailing whitespace', '09121234567 '],
      ['trailing newline (regex anchors are ^ and $)', '09121234567\n'],
      ['persian digits', '۰۹۱۲۱۲۳۴۵۶۷'],
      ['double prefix', '+9800989121234567'],
      ['ordinary username', 'ali_reza'],
      ['numeric username', '12345678901'],
      ['username that starts like a phone', '09121234567abc'],
      ['empty string', ''],
    ])('%s -> username: %p', (_label, input) => {
      expect(detectIdentifierType(input)).toBe('username');
      expect(isIranPhoneNumber(input)).toBe(false);
    });

    it('is consistent with iranPhoneSchema on every sample', () => {
      const samples = [
        '09121234567',
        '+989121234567',
        '00989121234567',
        '0912123456',
        'ali_reza',
        '',
      ];
      for (const s of samples) {
        expect(detectIdentifierType(s) === 'phone').toBe(
          iranPhoneSchema.safeParse(s).success,
        );
      }
    });
  });
});
