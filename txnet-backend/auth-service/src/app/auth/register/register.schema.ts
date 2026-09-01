import { z } from 'zod';
import { strongPasswordSchema } from '../../common/validation/strong-password.schema';
import { iranPhoneSchema } from '../../common/validation/phone.schema';

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
  phoneNumber: iranPhoneSchema,
  password: strongPasswordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const verifyPhoneSchema = z.object({
  userId: z.string().uuid('userId.invalid'),
  otpCode: z
    .string()
    .length(6, 'otp.invalidLength')
    .regex(/^\d+$/, 'otp.mustBeNumeric'),
});

export type VerifyPhoneInput = z.infer<typeof verifyPhoneSchema>;
