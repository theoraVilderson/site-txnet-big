import { z } from 'zod';

const IRAN_MOBILE_REGEX = /^(?:\+98|0098|0)9\d{9}$/;

export const iranPhoneSchema = z
  .string()
  .regex(IRAN_MOBILE_REGEX, 'phone.invalidFormat')
  .transform(normalizeIranPhone);

/** Normalizes any Iranian phone format to 09xxxxxxxxx. */
export function normalizeIranPhone(raw: string): string {
  const digits = raw.replace(/^\+98|^0098|^0/, '');
  return `0${digits}`;
}

export function isIranPhoneNumber(value: string): boolean {
  return IRAN_MOBILE_REGEX.test(value);
}

export function detectIdentifierType(identifier: string): 'phone' | 'username' {
  return isIranPhoneNumber(identifier) ? 'phone' : 'username';
}
