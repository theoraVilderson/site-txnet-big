import { z } from 'zod';

export const captchaVerifySchema = z.object({
  challengeId: z.string().min(10).max(100),
});

export type CaptchaVerifyInput = z.infer<typeof captchaVerifySchema>;
