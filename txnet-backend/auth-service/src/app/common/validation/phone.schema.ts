import { z } from 'zod';
import {
  CountryCode,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';

/**
 * Phone numbers are a **library**, not a regex, and the canonical stored form
 * is E.164 (`+989123456789`). See ADR-0018.
 *
 * Two knobs, both optional, both read from the process environment rather
 * than injected: these are module-level zod schemas built once at import
 * time, the same way the Iran regex they replace was. `envSchema`
 * (`config/env.validation.ts`) declares and documents both, so a deployment
 * still configures them in one place.
 *
 *   DEFAULT_PHONE_COUNTRY      the region a number typed without `+` belongs
 *                              to. Defaults to the region of DEFAULT_LANGUAGE
 *                              — a fa deployment reads `09123456789` as
 *                              Iranian without anyone saying so.
 *   SUPPORTED_PHONE_COUNTRIES  optional allow-list of ISO codes. Empty (the
 *                              default) means every country the library
 *                              knows, which is the point: the picker in the
 *                              panel offers all of them, like Telegram's.
 */

/**
 * The regions the languages this platform serves imply. A language is not a
 * country, so this map is deliberately small and explicit: an unlisted
 * language yields no default region, and a number then has to carry its own
 * `+` prefix. Guessing a region from a language nobody mapped is how a
 * German-speaking user's number silently becomes an Iranian one.
 */
const LANGUAGE_REGION: Readonly<Record<string, CountryCode>> = {
  fa: 'IR',
  en: 'US',
};

function env(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : undefined;
}

/** The region an unprefixed number is read as. `undefined` = E.164 only. */
export function defaultPhoneCountry(): CountryCode | undefined {
  const explicit = env('DEFAULT_PHONE_COUNTRY')?.toUpperCase();
  if (explicit && isSupportedCountry(explicit)) return explicit as CountryCode;

  const language = (env('DEFAULT_LANGUAGE') ?? 'fa').toLowerCase().split(/[-_]/)[0];
  const region = LANGUAGE_REGION[language];
  return region && isSupportedCountry(region) ? region : undefined;
}

/** Every country the deployment accepts, in ISO 3166-1 alpha-2. */
export function supportedPhoneCountries(): CountryCode[] {
  const configured = env('SUPPORTED_PHONE_COUNTRIES');
  if (!configured) return getCountries();

  const allowed = new Set(
    configured
      .split(',')
      .map((iso) => iso.trim().toUpperCase())
      .filter(Boolean),
  );
  return getCountries().filter((iso) => allowed.has(iso));
}

function isSupportedCountry(iso: string): boolean {
  return supportedPhoneCountries().includes(iso as CountryCode);
}

/** The dial prefix for a country, without the `+` — `IR` -> `98`. */
export function phoneCountryCallingCode(iso: CountryCode): string {
  return getCountryCallingCode(iso);
}

/**
 * A number is usable here only if it can receive an OTP, so a fixed line is
 * rejected the same way the old Iran-only regex rejected everything that was
 * not an `09` mobile. FIXED_LINE_OR_MOBILE is kept: several countries do not
 * separate the two in their numbering plan at all, and refusing those would
 * lock out whole regions.
 */
const OTP_CAPABLE_TYPES = new Set([
  'MOBILE',
  'FIXED_LINE_OR_MOBILE',
  undefined,
]);

/**
 * Parses any human-typed form into E.164, or returns undefined.
 * `country` overrides the deployment default — the panel sends the country
 * its picker is on.
 */
/**
 * The library is deliberately forgiving: it will read `09121234567abc` as a
 * number by discarding the tail. That is right for scraping text and wrong
 * for an identifier field, where it would turn the username
 * `09121234567abc` into someone else's phone number. So the input must look
 * like a phone number *entirely* before the library sees it: dial characters
 * and digits in any script, nothing else.
 */
const DIAL_CHARACTERS = /^[+\s\-().\u200f\u200e\d\p{Nd}]+$/u;

export function parsePhone(
  raw: string,
  country: CountryCode | undefined = defaultPhoneCountry(),
): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  if (!DIAL_CHARACTERS.test(raw.trim())) return undefined;

  const parsed = parsePhoneNumberFromString(raw.trim(), country);
  if (!parsed || !parsed.isValid()) return undefined;
  if (!parsed.country || !isSupportedCountry(parsed.country)) return undefined;
  if (!OTP_CAPABLE_TYPES.has(parsed.getType())) return undefined;

  return parsed.number;
}

/** E.164 or throw. Callers that already validated with the schema use this. */
export function normalizePhone(raw: string, country?: CountryCode): string {
  const e164 = parsePhone(raw, country);
  if (!e164) throw new Error('phone.invalidFormat');
  return e164;
}

/**
 * Every spelling of one number, for substring checks such as "this password
 * contains your phone number". The canonical form is E.164, so a password
 * containing the national form a user actually thinks in (`09123456789`)
 * would otherwise pass a plain `includes()` against `+989123456789` — the
 * rule would still be there and would no longer hold. Country-agnostic: the
 * trunk prefix comes from the library's own national formatting, not from a
 * per-country branch.
 */
export function phoneVariants(raw: string): string[] {
  const e164 = parsePhone(raw) ?? (typeof raw === 'string' ? raw.trim() : '');
  if (!e164) return [];

  const parsed = parsePhoneNumberFromString(e164);
  const forms = new Set<string>([e164, e164.replace(/^\+/, '')]);
  if (parsed) {
    forms.add(parsed.nationalNumber);
    forms.add(parsed.formatNational().replace(/\D/g, ''));
  }
  return [...forms].filter((form) => form.length >= 3);
}

export function isPhoneNumber(value: string): boolean {
  return parsePhone(value) !== undefined;
}

/**
 * Usernames are never valid phone numbers, and a phone number is never a
 * username: anything the library can parse into a real, reachable number is a
 * phone, everything else is a username. Letters can never parse, so the two
 * spaces cannot overlap.
 */
export function detectIdentifierType(identifier: string): 'phone' | 'username' {
  return isPhoneNumber(identifier) ? 'phone' : 'username';
}

/** The stored form. Every phone field on the wire goes through this. */
export const phoneSchema = z
  .string()
  .transform((raw, ctx) => {
    const e164 = parsePhone(raw);
    if (!e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'phone.invalidFormat' });
      return z.NEVER;
    }
    return e164;
  });
