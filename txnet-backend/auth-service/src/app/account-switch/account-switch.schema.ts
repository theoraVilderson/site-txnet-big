import { z } from 'zod';
import { iranPhoneSchema } from '../common/validation/phone.schema';
import { OtpChannel } from '../auth/otp/otp.interface';

/** Ask for a proof code on the phone of the account being added. */
export const addByOtpRequestSchema = z.object({
  phoneNumber: iranPhoneSchema,
  channel: z.nativeEnum(OtpChannel).optional(),
});

/** Spend that code and join the group. */
export const addByOtpVerifySchema = z.object({
  phoneNumber: iranPhoneSchema,
  otpCode: z.string().length(6).regex(/^\d+$/),
});

/**
 * Join by password instead. `identifier` is a phone number or a username —
 * the same shape `login/password` accepts, because it is the same credential
 * and a second spelling of it would be a second thing to keep in step.
 */
export const addByPasswordSchema = z.object({
  identifier: z.string().trim().min(3),
  password: z.string().min(1),
});

/**
 * Switch to a member of the caller's own group (F-0207). The body names only
 * the target: no credential, which is the entire point of the group — the
 * credential was spent once, when that account joined.
 */
export const switchAccountSchema = z.object({
  userId: z.string().uuid(),
});

/**
 * Remove a member from the group on this surface (F-0208). Same shape as
 * `switchAccountSchema` and no credential either, for the same reason: the
 * caller is already a proven member of the group being changed. `userId` may
 * be the caller's own — that is how an account leaves.
 */
export const removeAccountSchema = z.object({
  userId: z.string().uuid(),
});

export type AddByOtpRequestInput = z.infer<typeof addByOtpRequestSchema>;
export type AddByOtpVerifyInput = z.infer<typeof addByOtpVerifySchema>;
export type AddByPasswordInput = z.infer<typeof addByPasswordSchema>;
export type SwitchAccountInput = z.infer<typeof switchAccountSchema>;
export type RemoveAccountInput = z.infer<typeof removeAccountSchema>;
