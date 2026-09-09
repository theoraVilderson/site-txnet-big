import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CountryCode,
  getCountries,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';

/**
 * The bot's half of ADR-0018 — the same job `site-pwa/src/lib/phone.ts` does
 * for the panel, and deliberately no more than that.
 *
 * The panel has a country picker, so a number typed there arrives at
 * `auth-api` already spelled as E.164. A chat has no picker, so the bot was
 * handing over whatever the user typed and whatever the messenger reported,
 * and `auth-service`'s `phoneSchema` read both against the deployment's own
 * region. Two spellings lost that way, both from outside that region:
 *
 *  - a **shared contact**. Telegram reports the number the account was
 *    registered with and drops the `+`, so a German contact arrives as
 *    `4915112345678` — international, unmarked, and invalid as a national
 *    number anywhere.
 *  - a number **typed with `+`** was already fine; a number typed bare still
 *    belongs to the deployment's region, and always will until there is a
 *    country step to say otherwise (a screen, and a separate decision).
 *
 * This class only *spells* a number. It never rejects one: an input it cannot
 * read is passed through exactly as it arrived, so the answer to "is this a
 * number, and may it hold an account here?" stays where it belongs —
 * `auth-service`'s `parsePhone`, behind `auth-api` (ADR-0009).
 */

/**
 * Same map, same reason, as `auth-service`'s `phone.schema.ts` and the panel's
 * `phone.ts`: a language is not a country, so only the languages this platform
 * serves are listed. An unmapped language yields no region, and a bare
 * national number is then simply passed through for `auth-api` to judge.
 */
const LANGUAGE_REGION: Readonly<Record<string, CountryCode>> = {
  fa: 'IR',
  en: 'US',
};

/**
 * The library reads `09121234567abc` as a number by discarding the tail, which
 * is right for scraping prose and wrong here — this step also receives typos
 * and stray words. Dial characters and digits in any script, nothing else;
 * copied verbatim from `auth-service` so the two agree on what even looks like
 * a phone number.
 */
const DIAL_CHARACTERS = /^[+\s\-().\u200f\u200e\d\p{Nd}]+$/u;

function e164(value: string, region: CountryCode | undefined): string | null {
  const parsed = parsePhoneNumberFromString(value, region);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * `raw` in the canonical form, or `null` if it is not readable as one.
 *
 * Two readings, in this order, because they genuinely differ: `09121234567` is
 * national and `4915112345678` is international with its `+` missing. Trying
 * national first and international second is what makes both work without a
 * per-country branch — the same rule `normalizeMessengerPhone` applies on the
 * `identity` side of the contact proof.
 */
export function readPhoneNumber(
  raw: string,
  region: CountryCode | undefined,
): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || !DIAL_CHARACTERS.test(trimmed)) return null;

  const national = e164(trimmed, region);
  if (national) return national;

  const digits = trimmed.replace(/\p{Nd}/gu, (d) => digitValue(d)).replace(/\D/g, '');
  return digits ? e164(`+${digits}`, undefined) : null;
}

/**
 * `۹` -> `9`. Persian and Arabic-Indic digits reach the library intact on the
 * first reading, but the second one rebuilds the string itself and would drop
 * every non-ASCII digit on the floor — a Persian-typed foreign number would
 * then read as a shorter, valid, *different* number.
 */
function digitValue(digit: string): string {
  const code = digit.codePointAt(0) ?? 0;
  for (let value = 0; value <= 9; value++) {
    // The zero of a digit's own block is the first codepoint below it that is
    // not itself a digit, at most nine steps down. `Number('۹')` is NaN and
    // NFKD leaves the character alone, so this arithmetic is the portable way
    // to ask what a digit is worth without a table per script.
    if (!/\p{Nd}/u.test(String.fromCodePoint(code - value - 1))) return String(value);
  }
  return '';
}

@Injectable()
export class PhoneNumbers {
  /** The region a number typed without a `+` belongs to. */
  private readonly region: CountryCode | undefined;

  constructor(config: ConfigService) {
    this.region = resolveRegion(
      config.get<string>('DEFAULT_PHONE_COUNTRY'),
      config.get<string>('BOT_DEFAULT_LANGUAGE'),
      config.get<string>('DEFAULT_LANGUAGE'),
    );
  }

  /**
   * The number as `auth-api` stores it, or the input untouched. Every phone
   * step calls this, and none of them branches on the result: an unreadable
   * answer travels on and comes back as `auth-api`'s own refusal, in the
   * user's language, exactly as it did before this file existed.
   */
  read(raw: string): string {
    const trimmed = (raw ?? '').trim();
    return readPhoneNumber(trimmed, this.region) ?? trimmed;
  }
}

/**
 * `DEFAULT_PHONE_COUNTRY` wins; otherwise the language the bot speaks implies
 * one, bot-first for the same reason `ChatLanguage` is bot-first (ADR-0016) —
 * a bot that sells in another language sells to that language's numbers.
 */
export function resolveRegion(
  explicit: string | undefined,
  botLanguage: string | undefined,
  defaultLanguage: string | undefined,
): CountryCode | undefined {
  const iso = explicit?.trim().toUpperCase();
  if (iso && (getCountries() as string[]).includes(iso)) return iso as CountryCode;

  for (const language of [botLanguage, defaultLanguage]) {
    const base = language?.trim().toLowerCase().split(/[-_]/)[0];
    if (base && LANGUAGE_REGION[base]) return LANGUAGE_REGION[base];
  }
  return undefined;
}
