import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError, z } from 'zod';
import {
  formatPricetoToman,
  parsePersianDate,
  toEnglishDigits,
  toToman,
  zodErrorToString,
} from './helper';

// `parsePersianDate` logs on every call; keep the suite output readable.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('toToman', () => {
  it.each([
    ['whole toman', 10_000, 1_000],
    ['zero', 0, 0],
    ['one rial rounds up to one toman', 1, 1],
    ['nine rial rounds up to one toman', 9, 1],
    ['exactly ten rial', 10, 1],
    ['eleven rial rounds up', 11, 2],
    ['large amount', 123_456_789, 12_345_679],
  ])('%s: %i rial -> %i toman', (_label, rial, toman) => {
    expect(toToman(rial)).toBe(toman);
  });

  it('always rounds up, never down — the user is never undercharged', () => {
    for (let rial = 0; rial <= 100; rial++) {
      expect(toToman(rial)).toBeGreaterThanOrEqual(rial / 10);
      expect(toToman(rial) - rial / 10).toBeLessThan(1);
    }
  });

  it.each([
    ['float input is ceiled too', 10.5, 2],
    ['float that lands exactly', 100.0, 10],
    ['sub-rial float', 0.4, 1],
  ])('%s: %p -> %i', (_label, rial, toman) => {
    expect(toToman(rial)).toBe(toman);
  });

  describe('negative amounts (refunds) round toward zero, not away from it', () => {
    // Math.ceil(-1.5) === -1. A refund therefore loses up to 9 rial in the
    // user's favour. Pinned as current behaviour, not endorsed as policy.
    it.each([
      [-10, -1],
      [-15, -1],
      [-19, -1],
      [-20, -2],
    ])('%i rial -> %i toman', (rial, toman) => {
      expect(toToman(rial)).toBe(toman);
    });
  });

  it('propagates non-finite input instead of masking it', () => {
    expect(toToman(NaN)).toBeNaN();
    expect(toToman(Infinity)).toBe(Infinity);
  });
});

describe('formatPricetoToman', () => {
  // Note the export is `formatPricetoToman` (lowercase `to`), not
  // `formatPriceToToman`. Renaming it is a separate change.
  const persianDigitsToEnglish = (s: string) =>
    toEnglishDigits(s).replace(/[^\d-]/g, '');

  it.each([
    ['ten thousand rial', 10_000],
    ['zero', 0],
    ['single toman', 5],
    ['a million rial', 1_000_000],
    ['an amount needing rounding', 12_345],
  ])('%s renders the toman value in Persian digits', (_label, rial) => {
    const formatted = formatPricetoToman(rial);
    expect(persianDigitsToEnglish(formatted)).toBe(String(toToman(rial)));
  });

  it('emits Persian digits, never ASCII ones', () => {
    const formatted = formatPricetoToman(10_000);
    expect(formatted).toMatch(/[۰-۹]/);
    expect(formatted).not.toMatch(/[0-9]/);
  });

  it('groups thousands', () => {
    // 10,000 rial = 1,000 toman -> four digits plus one group separator.
    const formatted = formatPricetoToman(10_000);
    expect(formatted.replace(/[۰-۹]/g, '')).not.toBe('');
  });

  it('does not group a value below one thousand', () => {
    const formatted = formatPricetoToman(9_990); // 999 toman
    expect(formatted.replace(/[۰-۹]/g, '')).toBe('');
  });

  it('is consistent with toToman for every sample', () => {
    for (const rial of [0, 1, 9, 10, 11, 999, 10_000, 987_654_321]) {
      expect(persianDigitsToEnglish(formatPricetoToman(rial))).toBe(
        String(toToman(rial)),
      );
    }
  });
});

describe('toEnglishDigits', () => {
  it.each([
    ['persian digits', '۰۱۲۳۴۵۶۷۸۹', '0123456789'],
    ['a phone number', '۰۹۱۲۱۲۳۴۵۶۷', '09121234567'],
    ['digits inside persian text', 'کد شما ۱۲۳۴۵۶ است', 'کد شما 123456 است'],
    ['already english', '0912', '0912'],
    ['mixed scripts', '۱2۳4', '1234'],
    ['no digits at all', 'سلام', 'سلام'],
    ['punctuation is untouched', '۱۲۳/۴۵', '123/45'],
  ])('%s: %p -> %p', (_label, input, expected) => {
    expect(toEnglishDigits(input)).toBe(expected);
  });

  it.each([
    ['empty string', ''],
    ['undefined', undefined as unknown as string],
    ['null', null as unknown as string],
  ])('%s returns an empty string rather than throwing', (_label, input) => {
    expect(toEnglishDigits(input)).toBe('');
  });

  it('is idempotent', () => {
    const once = toEnglishDigits('کد ۱۲۳');
    expect(toEnglishDigits(once)).toBe(once);
  });

  describe('Arabic-Indic digits are NOT converted', () => {
    // The range is U+06F0-U+06F9 (Persian) only. Arabic-Indic U+0660-U+0669
    // — what an Arabic keyboard produces — falls straight through. Real gap:
    // this is the string that later reaches `parseInt`.
    it.each([
      ['arabic-indic zero to nine', '٠١٢٣٤٥٦٧٨٩'],
      ['arabic-indic phone', '٠٩١٢١٢٣٤٥٦٧'],
    ])('%s stays as-is', (_label, input) => {
      expect(toEnglishDigits(input)).toBe(input);
    });
  });
});

describe('parsePersianDate', () => {
  it('converts 1 Farvardin 1402 to 21 March 2023', () => {
    const date = parsePersianDate('1402/01/01');
    expect(date).toBeInstanceOf(Date);
    expect(date?.getFullYear()).toBe(2023);
    expect(date?.getMonth()).toBe(2); // March, zero-based
    expect(date?.getDate()).toBe(21);
  });

  it.each([
    ['1402/01/01', 2023, 2, 21],
    ['1402/12/29', 2024, 2, 19], // last day of a non-leap jalaali year
    ['1403/12/30', 2025, 2, 20], // 1403 is a leap year: Esfand has 30 days
    ['1400/07/01', 2021, 8, 23],
  ])('%s -> %i-%i-%i', (input, gy, gmIndex, gd) => {
    const date = parsePersianDate(input);
    expect(date?.getFullYear()).toBe(gy);
    expect(date?.getMonth()).toBe(gmIndex);
    expect(date?.getDate()).toBe(gd);
  });

  it('accepts dashes as well as slashes', () => {
    expect(parsePersianDate('1402-01-01')?.getTime()).toBe(
      parsePersianDate('1402/01/01')?.getTime(),
    );
  });

  it('defaults to the start of the day', () => {
    const date = parsePersianDate('1402/01/01');
    expect([
      date?.getHours(),
      date?.getMinutes(),
      date?.getSeconds(),
      date?.getMilliseconds(),
    ]).toEqual([0, 0, 0, 0]);
  });

  it('snaps to the last instant of the day when isEndOfDay is set', () => {
    const date = parsePersianDate('1402/01/01', true);
    expect([
      date?.getHours(),
      date?.getMinutes(),
      date?.getSeconds(),
      date?.getMilliseconds(),
    ]).toEqual([23, 59, 59, 999]);
  });

  it('produces a from/to range that covers exactly one day', () => {
    const from = parsePersianDate('1402/01/01') as Date;
    const to = parsePersianDate('1402/01/01', true) as Date;
    expect(to.getTime() - from.getTime()).toBe(86_400_000 - 1);
  });

  it.each([
    ['empty string', ''],
    ['undefined', undefined as unknown as string],
    ['two parts only', '1402/01'],
    ['four parts', '1402/01/01/01'],
    ['no separator', '14020101'],
  ])('%s -> undefined', (_label, input) => {
    expect(parsePersianDate(input)).toBeUndefined();
  });

  describe('malformed parts produce a plausible-looking wrong Date, not undefined', () => {
    // The guard only counts the parts. `parseInt` then yields NaN, jalaali-js
    // maps NaN to year -100100, and the function returns a perfectly valid
    // Date object. A caller that only checks for `undefined` will happily send
    // that year to the API. Pinned so a fix is a visible test change.
    it.each(['abc/def/ghi', '\u06f1\u06f4\u06f0\u06f2/\u06f0\u06f1/\u06f0\u06f1', '//'])('%p', (input) => {
      const date = parsePersianDate(input);
      expect(date).toBeInstanceOf(Date);
      expect(date?.getTime()).not.toBeNaN();
      expect(date?.getFullYear()).toBe(-100100);
    });

    it('Persian digits are not normalized first — pipe them through toEnglishDigits', () => {
      const persian = '\u06f1\u06f4\u06f0\u06f2/\u06f0\u06f1/\u06f0\u06f1';
      expect(parsePersianDate(persian)?.getFullYear()).toBe(-100100);
      expect(parsePersianDate(toEnglishDigits(persian))?.getFullYear()).toBe(2023);
    });

    it('an out-of-range month or day rolls over instead of being rejected', () => {
      // 1402/13/40 is not a date; jalaali-js normalizes it to 2024-04-29.
      const date = parsePersianDate('1402/13/40');
      expect(date?.getFullYear()).toBe(2024);
      expect(date?.getMonth()).toBe(3);
      expect(date?.getDate()).toBe(29);
    });
  });

  it('does not throw on any malformed input', () => {
    for (const input of ['', 'x', '1402', '1402/13/40', 'abc/def/ghi', '//']) {
      expect(() => parsePersianDate(input)).not.toThrow();
    }
  });
});

describe('zodErrorToString', () => {
  const errorFor = (schema: z.ZodTypeAny, value: unknown): ZodError => {
    const result = schema.safeParse(value);
    if (result.success) throw new Error('expected a validation failure');
    return result.error;
  };

  it('prefixes the field path by default', () => {
    const error = errorFor(
      z.object({ username: z.string().min(3, 'نام کاربری الزامی است') }),
      { username: 'a' },
    );
    expect(zodErrorToString(error)).toBe('username: نام کاربری الزامی است');
  });

  it('omits the path when withPath is false', () => {
    const error = errorFor(
      z.object({ username: z.string().min(3, 'نام کاربری الزامی است') }),
      { username: 'a' },
    );
    expect(zodErrorToString(error, { withPath: false })).toBe(
      'نام کاربری الزامی است',
    );
  });

  it('joins nested paths with a dot', () => {
    const error = errorFor(
      z.object({ user: z.object({ name: z.string('required') }) }),
      { user: {} },
    );
    expect(zodErrorToString(error)).toContain('user.name: ');
  });

  it('joins multiple issues with a newline by default', () => {
    const error = errorFor(
      z.object({ a: z.string('a bad'), b: z.string('b bad') }),
      {},
    );
    expect(zodErrorToString(error).split('\n')).toHaveLength(2);
  });

  it('honours a custom separator', () => {
    const error = errorFor(
      z.object({ a: z.string('a bad'), b: z.string('b bad') }),
      {},
    );
    expect(zodErrorToString(error, { separator: ' | ' })).toContain(' | ');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an object without issues', {}],
  ])('%s falls back to the generic message', (_label, value) => {
    expect(zodErrorToString(value as unknown as ZodError)).toBe(
      'خطای ناشناخته در اعتبارسنجی',
    );
  });
});
