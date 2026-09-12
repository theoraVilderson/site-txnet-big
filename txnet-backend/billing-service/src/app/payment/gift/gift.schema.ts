import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

export const giftRedeemSchema = z.object({
  /**
   * As typed. The service trims and upper-cases it, so the bound is on what a
   * `coupon.code` can hold rather than on a canonical form. Legacy's
   * `giftCheckSchema` capped it at 20; 64 is the cap the top-up box already
   * puts on a code, and one cap for both boxes is one fewer thing to disagree.
   */
  code: z
    .string({ message: E.giftCodeInvalid })
    .trim()
    .min(1, { message: E.giftCodeInvalid })
    .max(64, { message: E.giftCodeInvalid }),
});

export type GiftRedeemBody = z.infer<typeof giftRedeemSchema>;
