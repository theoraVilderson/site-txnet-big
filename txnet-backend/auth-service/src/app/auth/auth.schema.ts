import { z } from 'zod';
import { phoneSchema } from '../common/validation/phone.schema';
import { strongPasswordSchema } from '../common/validation/strong-password.schema';
import { OtpChannel } from './otp/otp.interface';

export const passwordLoginSchema = z.object({
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
});

export const otpRequestSchema = z.object({
  phoneNumber: phoneSchema,
  // اگر کاربر ندهد، از preferredOtpChannel پروفایل یا sms پیش‌فرض استفاده می‌شود
  channel: z.nativeEnum(OtpChannel).optional(),
});

export const otpVerifySchema = z
  .object({
    phoneNumber: phoneSchema.optional(),
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
  phoneNumber: phoneSchema,
  channel: z.nativeEnum(OtpChannel).optional(),
});

// F-035-g. 254 is the longest address SMTP will carry (RFC 5321).
const emailAddressSchema = z.string().trim().max(254).email();

export const meEmailRequestSchema = z.object({
  email: emailAddressSchema,
});

export const meEmailVerifySchema = z.object({
  email: emailAddressSchema,
  otpCode: z.string().length(6).regex(/^\d+$/),
});

export const forgotVerifySchema = z.object({
  phoneNumber: phoneSchema,
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
/**
 * The handle a 202 hands back (F-067-a). A hex id and nothing else — it names
 * one send, not a phone number, so a caller cannot turn it into a question
 * about who was sent a code.
 */
export const otpDeliveryStatusSchema = z.object({
  deliveryId: z.string().regex(/^[0-9a-f]{32}$/),
});

export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ForgotVerifyInput = z.infer<typeof forgotVerifySchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;

/** `POST /auth/handoff` (F-061-f): which of the caller's resellers to open. */
export const handoffIssueSchema = z.object({
  tenantId: z.string().uuid(),
});

/** `POST /auth/handoff/redeem`: the code, exactly as minted (32 bytes, base64url). */
export const handoffRedeemSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/**
 * `GET /auth/users?q=` (F-018-ad): a phone (any spelling), a username or an
 * email, or part of one. Three characters so a single letter is not a dump of
 * the tenant; one short page, no offset — refine the query instead.
 */
export const userSearchSchema = z.object({
  q: z.string().trim().min(3).max(64),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type UserSearchInput = z.infer<typeof userSearchSchema>;
