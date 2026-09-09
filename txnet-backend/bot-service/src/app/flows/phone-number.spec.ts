import { ConfigService } from '@nestjs/config';
import { PhoneNumbers, readPhoneNumber, resolveRegion } from './phone-number';

/**
 * The bot's phone step has no country picker, so what a number *means* is
 * decided here. Two properties matter and neither is obvious from the code:
 * a number from outside the deployment's region survives the trip, and
 * anything unreadable is handed on untouched rather than refused — this file
 * spells numbers, it does not validate them (`auth-api` does).
 */
describe('readPhoneNumber', () => {
  it('reads a bare national number as the deployment’s own country', () => {
    expect(readPhoneNumber('09121112233', 'IR')).toBe('+989121112233');
    expect(readPhoneNumber('۰۹۱۲۱۱۱۲۲۳۳', 'IR')).toBe('+989121112233');
  });

  it('keeps a number that names its own country, whichever way it is written', () => {
    expect(readPhoneNumber('+4915112345678', 'IR')).toBe('+4915112345678');
    expect(readPhoneNumber('004915112345678', 'IR')).toBe('+4915112345678');
    expect(readPhoneNumber('+1 202 555 0142', 'IR')).toBe('+12025550142');
  });

  /**
   * The shape this feature exists for. Telegram reports a contact's number the
   * way the account was registered and drops the `+`, so a German contact
   * arrives as `4915112345678`: not a national number anywhere, and read
   * against IR it is simply invalid.
   */
  it('reads an international number that lost its + on the way from the messenger', () => {
    expect(readPhoneNumber('4915112345678', 'IR')).toBe('+4915112345678');
    expect(readPhoneNumber('989121112233', 'IR')).toBe('+989121112233');
    expect(readPhoneNumber('۴۹۱۵۱۱۲۳۴۵۶۷۸', 'IR')).toBe('+4915112345678');
  });

  it('refuses to invent a number out of something that is not one', () => {
    expect(readPhoneNumber('sara', 'IR')).toBeNull();
    expect(readPhoneNumber('09121112233abc', 'IR')).toBeNull();
    expect(readPhoneNumber('  ', 'IR')).toBeNull();
    expect(readPhoneNumber('12345', 'IR')).toBeNull();
  });

  /**
   * A bare foreign *national* number still cannot work — `15551234567` is a
   * US number to an American and an invalid Iranian one to this parser. That
   * is what a country step would buy, and it is a screen of its own.
   */
  it('cannot rescue a bare national number from another country', () => {
    expect(readPhoneNumber('15551234567', 'IR')).toBeNull();
  });
});

describe('resolveRegion', () => {
  it('prefers the explicit country, then the bot’s language, then the platform’s', () => {
    expect(resolveRegion('de', 'fa', 'fa')).toBe('DE');
    expect(resolveRegion(undefined, 'en', 'fa')).toBe('US');
    expect(resolveRegion(undefined, undefined, 'fa')).toBe('IR');
  });

  it('has no region for a language nobody mapped, rather than guessing one', () => {
    expect(resolveRegion(undefined, undefined, 'tr')).toBeUndefined();
    expect(resolveRegion('ZZ', undefined, 'tr')).toBeUndefined();
  });
});

describe('PhoneNumbers', () => {
  const phones = (env: Record<string, string>) => new PhoneNumbers(new ConfigService(env));

  it('hands an unreadable answer on untouched, so auth-api still gives the reason', () => {
    expect(phones({ DEFAULT_LANGUAGE: 'fa' }).read('  not a number ')).toBe('not a number');
  });

  it('follows DEFAULT_PHONE_COUNTRY when the deployment sets one', () => {
    expect(phones({ DEFAULT_LANGUAGE: 'fa', DEFAULT_PHONE_COUNTRY: 'de' }).read('015112345678')).toBe(
      '+4915112345678',
    );
  });
});
