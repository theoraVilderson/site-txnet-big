import { z } from 'zod';
import { strongPasswordSchema } from '../../common/validation/strong-password.schema';
import { phoneSchema } from '../../common/validation/phone.schema';
import { OtpChannel } from '../otp/otp.interface';

export const registerSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, 'fullName.tooShort')
    .max(120, 'fullName.tooLong'),
  username: z
    .string()
    .trim()
    .min(3, 'username.tooShort')
    .max(32, 'username.tooLong')
    .regex(/^[a-zA-Z0-9_]+$/, 'username.invalidChars'),
  phoneNumber: phoneSchema,
  password: strongPasswordSchema,
  // Where the verification code should go. Omitted -> the environment's first
  // available channel; a deployment with SMS switched off registers over a
  // messenger instead.
  channel: z.nativeEnum(OtpChannel).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const verifyPhoneSchema = z.object({
  phoneNumber: phoneSchema,
  otpCode: z
    .string()
    .length(6, 'otp.invalidLength')
    .regex(/^\d+$/, 'otp.mustBeNumeric'),
});

export type VerifyPhoneInput = z.infer<typeof verifyPhoneSchema>;
