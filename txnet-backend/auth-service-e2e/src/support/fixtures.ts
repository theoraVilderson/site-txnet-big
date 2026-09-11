/** Account fixtures: unique identities, and the signup flow as one call. */
import { randomInt } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { AuthApi } from './api';
import type { OtpInbox } from './otp';

/**
 * Every account this suite creates used to be Iranian, because the service
 * accepted nothing else. It accepts every country now (ADR-0018), so the
 * fixtures rotate through six of them: registration, OTP issue and verify,
 * login by phone and the phone/username split are then all exercised against
 * numbers whose only shared property is being valid somewhere.
 *
 * Each entry is a country and a real, in-service mobile prefix. The random
 * tail is validated with the same library the service uses, so a fixture can
 * never hand the API a number it will reject — the failure would look like a
 * broken endpoint rather than a broken fixture.
 */
const PHONE_TEMPLATES: ReadonlyArray<{ iso: string; prefix: string; digits: number }> = [
  { iso: 'IR', prefix: '+98912', digits: 7 },
  { iso: 'US', prefix: '+1415555', digits: 4 },
  { iso: 'DE', prefix: '+4915112', digits: 6 },
  { iso: 'GB', prefix: '+447400', digits: 6 },
  { iso: 'TR', prefix: '+90532', digits: 7 },
  { iso: 'AE', prefix: '+97150', digits: 7 },
];

/** A valid, unused number, in a different country each time round. */
export function newPhoneNumber(n = ++phoneSequence): string {
  const template = PHONE_TEMPLATES[n % PHONE_TEMPLATES.length];

  for (let attempt = 0; attempt < 50; attempt++) {
    const tail = String(randomInt(0, 10 ** template.digits)).padStart(
      template.digits,
      '0',
    );
    const candidate = `${template.prefix}${tail}`;
    if (parsePhoneNumberFromString(candidate)?.isValid()) return candidate;
  }

  throw new Error(
    `could not build a valid ${template.iso} number from ${template.prefix}`,
  );
}

let phoneSequence = 0;

export interface Account {
  fullName: string;
  username: string;
  phoneNumber: string;
  password: string;
}

let sequence = 0;

/**
 * A fresh identity. The password deliberately shares nothing with the
 * username, full name or number — `assertPasswordNotContainingProfile`
 * rejects an overlap, and a fixture that tripped it would fail every spec
 * for the wrong reason.
 */
export function newAccount(overrides: Partial<Account> = {}): Account {
  const n = ++sequence;
  const suffix = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return {
    fullName: 'E2E Tester',
    username: `e2e_${n}_${suffix}`,
    phoneNumber: newPhoneNumber(n),
    password: 'Str0ng!Pa55phrase',
    ...overrides,
  };
}

export interface SignedUp {
  account: Account;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * register -> read the code off the console channel -> verify-phone.
 * Returns the session `verify-phone` hands out, and leaves the cookie in the
 * client's jar exactly as a browser would hold it.
 */
export async function signUp(
  api: AuthApi,
  otp: OtpInbox,
  overrides: Partial<Account> = {},
): Promise<SignedUp> {
  const account = newAccount(overrides);

  const registered = await api.register(account);
  // 202, not 201: `register` queues the code rather than sending it (v13,
  // F-067-a) and creates no row here in any case.
  if (registered.status !== 202) {
    throw new Error(
      `register failed: ${registered.status} ${JSON.stringify(registered.body)}`,
    );
  }

  const code = otp.latest(account.phoneNumber, 'register_phone_verify');
  const verified = await api.verifyPhone({
    phoneNumber: account.phoneNumber,
    otpCode: code,
  });
  if (verified.status !== 200 || !verified.body?.ok) {
    throw new Error(
      `verify-phone failed: ${verified.status} ${JSON.stringify(verified.body)}`,
    );
  }

  return {
    account,
    userId: verified.body.data.userId,
    accessToken: verified.body.data.accessToken,
    refreshToken: api.refreshCookie as string,
  };
}
