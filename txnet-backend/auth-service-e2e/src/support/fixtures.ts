/** Account fixtures: unique identities, and the signup flow as one call. */
import { randomInt } from 'node:crypto';
import type { AuthApi } from './api';
import type { OtpInbox } from './otp';

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
    phoneNumber: `091${String(n % 100).padStart(2, '0')}${suffix}${String(n % 10)}`.slice(0, 11),
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
  if (registered.status !== 201) {
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
