import { z } from 'zod';
import { registerSchema } from '../register/register.schema';

/**
 * `GET /auth/tenants/:tenantId/users` (F-311-a): one page of a reseller's own
 * users, optionally narrowed by `q`.
 *
 * `q` is F-018-ad's query — a phone in any spelling, part of a number, a
 * username or an email — and three characters for the same reason: a single
 * letter is a dump of the tenant wearing a search box. Unlike F-018-ad this
 * surface **does** page: a reseller reads its whole customer list here, where
 * the owner picker only ever wanted the top few matches.
 *
 * `pageSize` stops at 100 so one call cannot pull a tenant in a single page,
 * and the bot (F-311-c) has a page it can actually render.
 */
export const resellerUserListSchema = z.object({
  q: z.string().trim().min(3).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** `true`: only the team — people whose role holds any permission (F-1201-c). A query string, so `'true'` is the only yes. */
  staff: z.preprocess((v) => v === true || v === 'true', z.boolean()).optional(),
});

export type ResellerUserListQuery = z.infer<typeof resellerUserListSchema>;

/** `POST …/block` — why, shown to the person on the restricted screen (ADR-0133). */
export const resellerUserBlockSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .default({});

export type ResellerUserBlockBody = z.infer<typeof resellerUserBlockSchema>;

/**
 * `PATCH …/users/:userId` (AC-1-a): what staff may change about a person.
 * Name and username take register's own rules, so an edited account is one
 * register could have made. `email` is `null` only — staff remove an address,
 * never write one: a stored address is a proven one (identity invariant 15),
 * and the person proves a new one themselves. The phone is not here at all; it
 * is their sign-in. `.strict()`, so a field this surface does not edit is a
 * 400 rather than silently dropped.
 */
export const resellerUserProfileSchema = z
  .object({
    fullName: registerSchema.shape.fullName.optional(),
    username: registerSchema.shape.username.optional(),
    email: z.null().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'validation.nothingToChange' });

export type ResellerUserProfileBody = z.infer<typeof resellerUserProfileSchema>;
