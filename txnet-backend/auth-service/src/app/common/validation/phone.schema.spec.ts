import type { CountryCode } from 'libphonenumber-js/max';
import {
  defaultPhoneCountry,
  detectIdentifierType,
  isPhoneNumber,
  normalizePhone,
  parsePhone,
  phoneCountryCallingCode,
  phoneSchema,
  supportedPhoneCountries,
} from './phone.schema';

/**
 * The point of this file is that **nothing in it is Iran-shaped**. Phone
 * handling is a library over every country (ADR-0018), so the cases are a
 * table of country descriptors: adding a country here must not require a new
 * branch anywhere in the source, and the invariants below are asserted for
 * each row rather than for `IR` with the others bolted on.
 *
 * The two environment knobs are read on every call, not at import time, so a
 * test can move the deployment's default region the same way a deployment
 * does. Each block restores what it changed.
 */

type Sample = {
  iso: CountryCode;
  language: string; // a DEFAULT_LANGUAGE that implies this region
  e164: string; // the canonical stored form
  national: string; // what a local types, no country code
  international: string; // what a traveller types
  fixedLine?: string; // valid, but cannot receive an SMS
};

const COUNTRIES: Sample[] = [
  {
    iso: 'IR',
    language: 'fa',
    e164: '+989121234567',
    national: '09121234567',
    international: '00989121234567',
    fixedLine: '+982112345678',
  },
  {
    iso: 'US',
    language: 'en',
    e164: '+14155552671',
    national: '(415) 555-2671',
    international: '+1 415 555 2671',
  },
  {
    iso: 'DE',
    language: 'de',
    e164: '+4915112345678',
    national: '015112345678',
    international: '+49 151 1234 5678',
    fixedLine: '+4930901820',
  },
];

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.keys(values).map(
    (key) => [key, process.env[key]] as const,
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN_ENV = {
  DEFAULT_PHONE_COUNTRY: undefined,
  SUPPORTED_PHONE_COUNTRIES: undefined,
  DEFAULT_LANGUAGE: undefined,
};

describe('phone.schema', () => {
  describe('every country is a first-class citizen', () => {
    it.each(COUNTRIES)(
      '$iso: an international number normalizes to E.164 from any deployment',
      ({ iso, e164, international }) => {
        withEnv({ ...CLEAN_ENV }, () => {
          expect(parsePhone(international)).toBe(e164);
          expect(parsePhone(e164)).toBe(e164);
          expect(normalizePhone(e164)).toBe(e164);
          expect(isPhoneNumber(e164)).toBe(true);
          expect(phoneCountryCallingCode(iso)).toMatch(/^\d+$/);
        });
      },
    );

    it.each(COUNTRIES)(
      '$iso: a national number is understood when the caller names the country',
      ({ iso, e164, national }) => {
        withEnv({ ...CLEAN_ENV }, () => {
          expect(parsePhone(national, iso)).toBe(e164);
        });
      },
    );

    it.each(COUNTRIES)(
      '$iso: normalization is idempotent — the stored form parses to itself',
      ({ e164 }) => {
        withEnv({ ...CLEAN_ENV }, () => {
          expect(parsePhone(parsePhone(e164) as string)).toBe(e164);
        });
      },
    );

    it('accepts every country the library knows by default', () => {
      withEnv({ ...CLEAN_ENV }, () => {
        const supported = supportedPhoneCountries();
        expect(supported.length).toBeGreaterThan(200);
        for (const { iso } of COUNTRIES) expect(supported).toContain(iso);
      });
    });
  });

  describe('the default region comes from the deployment language', () => {
    it.each(COUNTRIES.filter((c) => ['fa', 'en'].includes(c.language)))(
      'DEFAULT_LANGUAGE=$language reads a bare national number as $iso',
      ({ iso, language, e164, national }) => {
        withEnv({ ...CLEAN_ENV, DEFAULT_LANGUAGE: language }, () => {
          expect(defaultPhoneCountry()).toBe(iso);
          expect(parsePhone(national)).toBe(e164);
        });
      },
    );

    it('DEFAULT_PHONE_COUNTRY overrides the language', () => {
      withEnv(
        { ...CLEAN_ENV, DEFAULT_LANGUAGE: 'fa', DEFAULT_PHONE_COUNTRY: 'de' },
        () => {
          expect(defaultPhoneCountry()).toBe('DE');
          expect(parsePhone('015112345678')).toBe('+4915112345678');
        },
      );
    });

    // A language is not a country. An unmapped one must not be guessed at:
    // the number then has to carry its own `+`, which is never ambiguous.
    it('a language with no mapped region leaves bare numbers unparseable', () => {
      withEnv({ ...CLEAN_ENV, DEFAULT_LANGUAGE: 'sw' }, () => {
        expect(defaultPhoneCountry()).toBeUndefined();
        expect(parsePhone('09121234567')).toBeUndefined();
        expect(parsePhone('+989121234567')).toBe('+989121234567');
      });
    });

    it('falls back to fa when DEFAULT_LANGUAGE is unset, matching envSchema', () => {
      withEnv({ ...CLEAN_ENV }, () => {
        expect(defaultPhoneCountry()).toBe('IR');
      });
    });
  });

  describe('SUPPORTED_PHONE_COUNTRIES narrows the deployment', () => {
    it('rejects a valid number from a country that is not enabled', () => {
      withEnv(
        { ...CLEAN_ENV, SUPPORTED_PHONE_COUNTRIES: 'IR' },
        () => {
          expect(supportedPhoneCountries()).toEqual(['IR']);
          expect(parsePhone('+989121234567')).toBe('+989121234567');
          expect(parsePhone('+4915112345678')).toBeUndefined();
          expect(detectIdentifierType('+4915112345678')).toBe('username');
        },
      );
    });

    it('is order- and case-insensitive, and ignores blanks', () => {
      withEnv(
        { ...CLEAN_ENV, SUPPORTED_PHONE_COUNTRIES: ' de , ir ,' },
        () => {
          expect(supportedPhoneCountries().sort()).toEqual(['DE', 'IR']);
        },
      );
    });
  });

  describe('a number must be able to receive an OTP', () => {
    it.each(COUNTRIES.filter((c) => c.fixedLine))(
      '$iso: a valid fixed line is refused — an SMS code cannot reach it',
      ({ fixedLine }) => {
        withEnv({ ...CLEAN_ENV }, () => {
          expect(parsePhone(fixedLine as string)).toBeUndefined();
        });
      },
    );

    // Several numbering plans do not separate mobile from fixed at all;
    // refusing those would lock out whole regions, so they stay accepted.
    it('accepts a number the plan cannot classify (FIXED_LINE_OR_MOBILE)', () => {
      withEnv({ ...CLEAN_ENV }, () => {
        expect(parsePhone('+14155552671')).toBe('+14155552671');
      });
    });
  });

  describe('phoneSchema — the wire shape', () => {
    it.each(COUNTRIES)('$iso: parses to the E.164 stored form', ({ e164, international }) => {
      withEnv({ ...CLEAN_ENV }, () => {
        expect(phoneSchema.parse(international)).toBe(e164);
      });
    });

    // The library is tolerant of how humans type, which the old Iran-only
    // regex was not: spaces, dashes, a stray newline and Persian digits all
    // reach the same stored number instead of being a 400 the user cannot
    // explain.
    it.each([
      ['spaces', '0912 123 4567'],
      ['dashes', '0912-123-4567'],
      ['surrounding whitespace', ' 09121234567 '],
      ['a trailing newline', '09121234567\n'],
      ['Persian digits', '۰۹۱۲۱۲۳۴۵۶۷'],
    ])('accepts %s and stores the canonical number', (_label, input) => {
      withEnv({ ...CLEAN_ENV, DEFAULT_LANGUAGE: 'fa' }, () => {
        expect(phoneSchema.parse(input)).toBe('+989121234567');
      });
    });

    it.each([
      ['too short', '0912123456'],
      ['too long', '0912123456789'],
      ['not a number at all', 'ali_reza'],
      ['empty', ''],
      ['only a plus', '+'],
      ['a country code with no subscriber number', '+98'],
    ])('rejects %s with the phone.invalidFormat key', (_label, input) => {
      withEnv({ ...CLEAN_ENV, DEFAULT_LANGUAGE: 'fa' }, () => {
        const result = phoneSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe('phone.invalidFormat');
        }
      });
    });

    it('rejects non-string input without running the transform', () => {
      expect(phoneSchema.safeParse(989121234567).success).toBe(false);
      expect(phoneSchema.safeParse(null).success).toBe(false);
      expect(phoneSchema.safeParse(undefined).success).toBe(false);
    });
  });

  describe('detectIdentifierType — the phone/username boundary', () => {
    it.each(COUNTRIES)('$iso: its E.164 number is a phone', ({ e164 }) => {
      withEnv({ ...CLEAN_ENV }, () => {
        expect(detectIdentifierType(e164)).toBe('phone');
      });
    });

    it.each([
      ['an ordinary username', 'ali_reza'],
      ['a username that starts like a phone', '09121234567abc'],
      ['digits that are not a real number anywhere', '12345678901234'],
      ['empty string', ''],
      ['a bare plus', '+'],
    ])('%s is a username', (_label, input) => {
      withEnv({ ...CLEAN_ENV, DEFAULT_LANGUAGE: 'fa' }, () => {
        expect(detectIdentifierType(input)).toBe('username');
      });
    });

    // The one invariant that has to hold for every input: the login path asks
    // `detectIdentifierType`, and the register path asks `phoneSchema`. If
    // they ever disagree, a user can register a number they cannot log in with.
    it('agrees with phoneSchema on every sample, in every deployment', () => {
      const samples = [
        ...COUNTRIES.flatMap((c) => [c.e164, c.international, c.national]),
        ...COUNTRIES.map((c) => c.fixedLine).filter(Boolean),
        'ali_reza',
        '0912123456',
        '',
      ] as string[];

      for (const language of ['fa', 'en', 'sw']) {
        withEnv({ ...CLEAN_ENV, DEFAULT_LANGUAGE: language }, () => {
          for (const sample of samples) {
            expect(detectIdentifierType(sample) === 'phone').toBe(
              phoneSchema.safeParse(sample).success,
            );
          }
        });
      }
    });
  });
});
