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

/**
 * The body of attaching a lost authority (F-092-af). `.strict()`, like the
 * confirmation. Only the gateway's own identifier — who and why are the
 * caller's identity and the log line; what it proves is the gateway's answer.
 */
export const manualAuthoritySchema = z
  .object({
    /** The gateway's authority, as its own panel shows it. */
    authority: z.string().trim().min(1, { message: 'authority must not be empty' }).max(64),
  })
  .strict();

export type ManualAuthorityBody = z.infer<typeof manualAuthoritySchema>;

/**
 * The body of rejecting a payment by hand (F-092-ak). `.strict()`, like the
 * others. Only a reason: what is closed is the row, as billing reads it.
 */
export const manualRejectSchema = z
  .object({
    /** Why a person, not the gateway, is ending this payment. Kept in the audit row. */
    reason: z.string().trim().min(5, { message: 'reason must be at least 5 characters' }).max(500),
  })
  .strict();

export type ManualRejectBody = z.infer<typeof manualRejectSchema>;

