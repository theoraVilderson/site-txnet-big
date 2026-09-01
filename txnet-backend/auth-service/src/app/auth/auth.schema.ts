import { z } from 'zod';
import { iranPhoneSchema } from '../common/validation/phone.schema';
import { strongPasswordSchema } from '../common/validation/strong-password.schema';
import { OtpChannel } from './otp/otp.interface';

export const passwordLoginSchema = z.object({
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
});

export const otpRequestSchema = z.object({
  phoneNumber: iranPhoneSchema,
  // اگر کاربر ندهد، از preferredOtpChannel پروفایل یا sms پیش‌فرض استفاده می‌شود
  channel: z.nativeEnum(OtpChannel).optional(),
});

export const otpVerifySchema = z
  .object({
    phoneNumber: iranPhoneSchema.optional(),
    otpToken: z.string().optional(),
    otpCode: z.string().length(6).regex(/^\d+$/),
  })
  .refine(
    (data) =>
      (data.phoneNumber || data.otpToken) &&
      !(data.phoneNumber && data.otpToken),
    { message: 'Provide either phoneNumber or otpToken, not both' },
  );

export const refreshSchema = z.object({
  refreshToken: z.string().min(32).optional(),
});

export const forgotPasswordSchema = z.object({
  phoneNumber: iranPhoneSchema,
  channel: z.nativeEnum(OtpChannel).optional(),
});

export const forgotVerifySchema = z.object({
  phoneNumber: iranPhoneSchema,
  otpCode: z.string().length(6).regex(/^\d+$/),
});

export const resetPasswordSchema = z.object({
  resetToken: z.string().min(20),
  newPassword: strongPasswordSchema,
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(32).optional(),
});

export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ForgotVerifyInput = z.infer<typeof forgotVerifySchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
