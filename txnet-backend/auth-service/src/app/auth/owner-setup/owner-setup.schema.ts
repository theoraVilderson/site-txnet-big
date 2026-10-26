import { z } from 'zod';
import { OtpChannel } from '../otp/otp.interface';
import { phoneSchema } from '../../common/validation/phone.schema';
import { strongPasswordSchema } from '../../common/validation/strong-password.schema';
import { registerSchema, verifyPhoneSchema } from '../register/register.schema';

/** `POST /auth/owner-setup/code` (F-0102): the code to the owner's own number. */
export const ownerSetupCodeSchema = z
  .object({
    setupToken: z.string().min(20),
    phoneNumber: phoneSchema,
    channel: z.nativeEnum(OtpChannel).optional(),
  })
  .strict();

/** `POST /auth/owner-setup` (F-0102): the account the owner keeps, proved by the code. */
export const ownerSetupSchema = z
  .object({
    setupToken: z.string().min(20),
    username: registerSchema.shape.username,
    newPassword: strongPasswordSchema,
    phoneNumber: phoneSchema,
    otpCode: verifyPhoneSchema.shape.otpCode,
  })
  .strict();

export type OwnerSetupCodeInput = z.infer<typeof ownerSetupCodeSchema>;
export type OwnerSetupInput = z.infer<typeof ownerSetupSchema>;
