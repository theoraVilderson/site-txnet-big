import { z } from 'zod';

/**
 * The wire shapes of user-group management (F-114-j).
 *
 * `.strict()` on every body, as discount-rule management's: an unknown key is
 * refused, not dropped. The schema bounds shapes; who may be named, and
 * whether "every reseller" is allowed, are `UserGroupAdminService`'s rules,
 * each answered with its own reason.
 */

const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });

const name = z.string().trim().min(1).max(80);

export const createUserGroupSchema = z.object({ name, allTenants: z.boolean().optional() }).strict();

export const updateUserGroupSchema = z
  .object({ name: name.optional(), allTenants: z.boolean().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.allTenants !== undefined, { message: 'name or allTenants is required' });

/** At most 500 of each per call: a larger list is several calls, each its own audit row. */
export const addUserGroupMembersSchema = z
  .object({ userIds: z.array(uuid('userIds')).max(500).optional(), tenantIds: z.array(uuid('tenantIds')).max(500).optional() })
  .strict()
  .refine((b) => (b.userIds?.length ?? 0) + (b.tenantIds?.length ?? 0) > 0, { message: 'userIds or tenantIds must name someone' });

export const userGroupMemberPageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateUserGroupBody = z.infer<typeof createUserGroupSchema>;
export type UpdateUserGroupBody = z.infer<typeof updateUserGroupSchema>;
export type AddUserGroupMembersBody = z.infer<typeof addUserGroupMembersSchema>;
export type UserGroupMemberPageQuery = z.infer<typeof userGroupMemberPageSchema>;
