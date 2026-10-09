import { z } from 'zod';

/**
 * The wire shape of a staff seat (F-018-j).
 *
 * `.strict()`: the invitation, the acceptance and the removal are the service's
 * to stamp, never the caller's — a body naming `joinedAt` is a 400, not a seat
 * that starts already accepted. The role is not here either: it is the user's
 * `identity.Role` (F-018-n), set at `PUT /auth/tenants/:id/users/:userId/role`
 * (F-1201-a) — the Team page sends it after the invite.
 */
export const inviteStaffSchema = z
  .object({
    userId: z.string().uuid(),
    /** ISO 8601; the seat ends here. Absent = no end date (F-1201's time-bound access is opt-in). */
    accessExpiresAt: z.coerce.date().optional(),
  })
  .strict();

export type InviteStaffInput = z.infer<typeof inviteStaffSchema>;

/** `PATCH .../staff/:memberId` (F-1201-b): a new end, or `null` for none. Required, so an empty body is a 400. */
export const seatExpirySchema = z.object({ accessExpiresAt: z.coerce.date().nullable() }).strict();

export type SeatExpiryInput = z.infer<typeof seatExpirySchema>;
