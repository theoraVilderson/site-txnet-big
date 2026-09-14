import { z } from 'zod';

/**
 * The body of a manual confirmation (F-092-z). `.strict()`: an unknown key is
 * refused, so nobody can hope to pass an amount — the credit is always the
 * row's own `amountCredited`.
 */
export const manualConfirmSchema = z
  .object({
    /** The gateway's reference number, as its own panel shows it. */
    referenceId: z.string().trim().min(1, { message: 'referenceId must not be empty' }).max(64),
    /** Why a person, not the gateway, is confirming this. Kept on the row and in the audit row. */
    reason: z.string().trim().min(5, { message: 'reason must be at least 5 characters' }).max(500),
  })
  .strict();

export type ManualConfirmBody = z.infer<typeof manualConfirmSchema>;
