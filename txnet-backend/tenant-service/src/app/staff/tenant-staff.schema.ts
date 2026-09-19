import { z } from 'zod';

/**
 * The wire shape of a staff seat (F-018-j).
 *
 * `.strict()`: the invitation, the acceptance and the removal are the service's
 * to stamp, never the caller's — a body naming `joinedAt` is a 400, not a seat
 * that starts already accepted. The role is not here either: it is the user's
 * `identity.Role` (F-018-n), administered at `/auth/roles`.
 */
export const inviteStaffSchema = z
  .object({
    userId: z.string().uuid(),
    /** ISO 8601; the seat ends here. Absent = no end date (F-1201's time-bound access is opt-in). */
    accessExpiresAt: z.coerce.date().optional(),
  })
  .strict();

export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;
