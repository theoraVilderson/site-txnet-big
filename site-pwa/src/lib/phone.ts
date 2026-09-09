import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  AsYouType,
  type CountryCode,
} from "libphonenumber-js/min";
import { DEFAULT_LOCALE } from "@/env";

/**
 * The panel's half of ADR-0018. The server decides what a valid number is;
 * this file only has to let a person *enter* one from any country, the way
 * Telegram does — a country selector plus the national number — and submit
 * the E.164 form the API stores.
 *
 * `min` metadata, not `max`: the browser needs formatting and a coarse
 * validity hint, and the extra ~100KB of `max` buys a mobile-vs-landline
 * distinction the server already enforces properly.
 */

/**
 * The region a language implies. Kept identical to the backend's map
 * (`auth-service/src/app/common/validation/phone.schema.ts`) on purpose: the
 * two must agree about what a bare national number means, or the panel
 * submits a number the server reads as a different country's.
 */
const LANGUAGE_REGION: Readonly<Record<string, CountryCode>> = {
  fa: "IR",
  en: "US",
};

/** Fallback when neither the app language nor the override names a region. */
const LAST_RESORT_REGION: CountryCode = "US";

/**
 * The country the picker opens on. `NEXT_PUBLIC_DEFAULT_PHONE_COUNTRY` wins;
 * otherwise it follows the language — the *app's* default language, not the
 * browser's, so a Persian deployment opens on Iran for everyone.
 */
export function defaultPhoneCountry(
  lang: string = DEFAULT_LOCALE,
): CountryCode {
  const override = process.env.NEXT_PUBLIC_DEFAULT_PHONE_COUNTRY?.toUpperCase();
  if (override && isKnownCountry(override)) return override as CountryCode;

  const base = (lang || DEFAULT_LOCALE).toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_REGION[base] ?? LAST_RESORT_REGION;
}

export function isKnownCountry(iso: string): boolean {
  return (getCountries() as string[]).includes(iso.toUpperCase());
}

export interface CountryOption {
  iso: CountryCode;
  /** The country's name in the language the panel is currently showing. */
  name: string;
  /** Dial prefix, with the `+`. */
  dialCode: string;
  /** The flag, from the ISO code's regional indicator letters. */
  flag: string;
}

/**
 * Every country the library knows, named in `lang` and sorted the way that
 * language sorts. `Intl.DisplayNames` is what makes this possible without
 * shipping a translated country list per language — the browser already has
 * one. Where it is unavailable the ISO code stands in, which is ugly but
 * never wrong.
 */
export function countryOptions(lang: string): CountryOption[] {
  let display: Intl.DisplayNames | undefined;
  try {
    display = new Intl.DisplayNames([lang], { type: "region" });
  } catch {
    display = undefined;
  }

  const options = getCountries().map((iso) => ({
    iso,
    name: safeRegionName(display, iso),
    dialCode: `+${getCountryCallingCode(iso)}`,
    flag: flagOf(iso),
  }));

  try {
    return options.sort((a, b) => a.name.localeCompare(b.name, lang));
  } catch {
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function safeRegionName(display: Intl.DisplayNames | undefined, iso: string) {
  try {
    return display?.of(iso) ?? iso;
  } catch {
    return iso;
  }
}

/** `IR` -> 🇮🇷, by offsetting each letter into the regional-indicator block. */
export function flagOf(iso: string): string {
  return iso
    .toUpperCase()
    .replace(/[A-Z]/g, (c) =>
      String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65),
    );
}

/** What the user typed plus the selected country -> the form the API takes. */
export function toE164(national: string, iso: CountryCode): string {
  const parsed = parsePhoneNumberFromString(national, iso);
  return (
    parsed?.number ?? `+${getCountryCallingCode(iso)}${digitsOf(national)}`
  );
}

/** A coarse "can this be submitted" hint. The server is the real validator. */
export function looksComplete(national: string, iso: CountryCode): boolean {
  return parsePhoneNumberFromString(national, iso)?.isValid() ?? false;
}

/**
 * Splits a stored E.164 number back into a country and a national number, so
 * a form can be prefilled without the user seeing `+98…` in a field that
 * expects national digits.
 */
export function fromE164(
  value: string,
  fallback: CountryCode,
): { iso: CountryCode; national: string } {
  const parsed = value ? parsePhoneNumberFromString(value) : undefined;
  if (!parsed?.country) return { iso: fallback, national: digitsOf(value) };
  return { iso: parsed.country, national: parsed.nationalNumber };
}

/** Formats as the user types, in the selected country's own grouping. */
export function formatAsTyped(national: string, iso: CountryCode): string {
  return new AsYouType(iso).input(national);
}

function digitsOf(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * What a keystroke in the number box means.
 *
 * The picker is not the only way to name a country, and insisting that it is
 * makes the field feel broken to anyone who already knows their own number.
 * A national number (`0912…`, `0151…`) belongs to whatever country the picker
 * is on. A number written in the international form (`+49…`) or in the
 * selected country's official IDD form (`0049…`) names its own country, and
 * moves the picker there — Telegram's behaviour, and the reason both spellings
 * can be pasted into this field without the user knowing which one it wants.
 *
 * The dial code is then taken *out* of the box and shown on the button, so the
 * field never holds `+49` twice.
 */
export function readTyped(
  typed: string,
  current: CountryCode,
): { iso: CountryCode; national: string } {
  const typer = new AsYouType(current);
  const formatted = typer.input(typed);

  // `isInternational()` covers both spellings — a leading `+`, and the IDD
  // prefix of the country the picker is on, which is how a person writes an
  // international call from home. `getCountry()` also answers for a purely
  // national number, so it is only trusted behind that check; it stays
  // undefined while a shared dial code (`+1`) is still ambiguous, and the
  // picker must not guess a country mid-keystroke.
  if (!typer.isInternational()) return { iso: current, national: formatted };

  const detected = typer.getCountry();
  if (!detected || detected === current)
    return { iso: current, national: formatted };

  const national = typer.getNumber()?.nationalNumber ?? "";
  return { iso: detected, national: formatAsTyped(national, detected) };
}
