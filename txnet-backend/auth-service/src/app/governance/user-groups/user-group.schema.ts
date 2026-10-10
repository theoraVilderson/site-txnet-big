import { z } from 'zod';

import type { UserGroupMemberChanges } from './user-group-admin.service';

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

/**
 * At most 500 of each per call: a larger list is several calls, each its own audit row.
 * `expiresAt` (GR-1-d): when every membership this call adds ends; one in the past is the service's `expiry_past`.
 */
export const addUserGroupMembersSchema = z
  .object({
    userIds: z.array(uuid('userIds')).max(500).optional(),
    tenantIds: z.array(uuid('tenantIds')).max(500).optional(),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict()
  .refine((b) => (b.userIds?.length ?? 0) + (b.tenantIds?.length ?? 0) > 0, { message: 'userIds or tenantIds must name someone' });

const end = z.coerce.date().nullable();

/**
 * Every member change a save makes (GR-1-i): adds — a person or a reseller,
 * each with its own end — removals, and end moves on members who stay. At
 * most 500 of each; nothing at all is refused. Who may be named, and whether
 * the list contradicts itself, are the service's (`member_conflict`).
 */
export const changeUserGroupMembersSchema = z
  .object({
    add: z
      .array(z.union([z.object({ userId: uuid('userId'), expiresAt: end.optional() }).strict(), z.object({ tenantId: uuid('tenantId'), expiresAt: end.optional() }).strict()]))
      .max(500)
      .default([]),
    remove: z
      .array(z.union([z.object({ userId: uuid('userId') }).strict(), z.object({ tenantId: uuid('tenantId') }).strict()]))
      .max(500)
      .default([]),
    // A reseller member's end too (GR-1-l): either kind of membership may end.
    ends: z
      .array(z.union([z.object({ userId: uuid('userId'), expiresAt: end }).strict(), z.object({ tenantId: uuid('tenantId'), expiresAt: end }).strict()]))
      .max(500)
      .default([]),
  })
  .strict()
  .refine((b) => b.add.length + b.remove.length + b.ends.length > 0, { message: 'add, remove or ends must name someone' });

/** A membership's end moved, or cleared with `null` (GR-1-d, ADR-0139 (3)). */
export const setUserGroupMemberEndSchema = z.object({ expiresAt: z.coerce.date().nullable() }).strict();

export const userGroupMemberPageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * `PUT /auth/user-groups/:id/access` (AC-1-m): the **whole** of what the group
 * gives — a role (or none) and extra keys. A partial edit would race two
 * admins into a half-applied group, as a role's keys would.
 */
export const setUserGroupAccessSchema = z
  .object({
    roleId: uuid('roleId').nullable(),
    keys: z.array(z.string().trim().min(3).max(64).regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/)).max(200),
  })
  .strict();

export type CreateUserGroupBody = z.infer<typeof createUserGroupSchema>;
export type UpdateUserGroupBody = z.infer<typeof updateUserGroupSchema>;
export type AddUserGroupMembersBody = z.infer<typeof addUserGroupMembersSchema>;
export type SetUserGroupMemberEndBody = { expiresAt: Date | null };
/** The service's own shape: this project's non-strict inference reads the union's fields optional. */
export type ChangeUserGroupMembersBody = UserGroupMemberChanges;
export type UserGroupMemberPageQuery = z.infer<typeof userGroupMemberPageSchema>;
/** `Required`: both fields are mandatory in the schema; this project's non-strict inference reads them optional. */
export type SetUserGroupAccessBody = Required<z.infer<typeof setUserGroupAccessSchema>>;
