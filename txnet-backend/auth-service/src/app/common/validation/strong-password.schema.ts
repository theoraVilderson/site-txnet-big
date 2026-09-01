import { z } from 'zod';

/**
 * Strong password policy: min 8, max 72, at least one uppercase, one lowercase,
 * one digit, one special char.
 */
export const strongPasswordSchema = z
  .string()
  .min(8, 'password.tooShort')
  .max(72, 'password.tooLong')
  .regex(/[a-z]/, 'password.needsLowercase')
  .regex(/[A-Z]/, 'password.needsUppercase')
  .regex(/[0-9]/, 'password.needsDigit')
  .regex(/[^A-Za-z0-9]/, 'password.needsSpecialChar');

/**
 * Asserts that the password does not contain profile data (username, fullName, phoneNumber).
 */
export function assertPasswordNotContainingProfile(
  password: string,
  profile: {
    username?: string | null;
    fullName?: string | null;
    phoneNumber?: string | null;
  },
): void {
  const lowerPassword = password.toLowerCase();
  const candidates = [
    profile.username,
    profile.fullName,
    profile.phoneNumber,
  ].filter((v): v is string => !!v && v.length >= 3);

  for (const candidate of candidates) {
    if (lowerPassword.includes(candidate.toLowerCase())) {
      throw new PasswordContainsProfileDataError();
    }
  }
}

export class PasswordContainsProfileDataError extends Error {
  readonly i18nKey = 'password.containsProfileData';
  constructor() {
    super('password must not contain profile data');
  }
}
