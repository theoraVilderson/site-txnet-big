import { UserPermissionEffect } from '@prisma/client';
import { z } from 'zod';

/**
 * A permission key as `identity.permission.key` spells one: a dotted
 * capability (`wallet.manual_adjust`). Validated for shape only — whether the
 * key exists, and whether the caller may grant it, is `RolesService.grantable`.
 */
const permissionKey = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);

/** A tenant names its own roles; the name is unique within that tenant. */
const roleName = z.string().trim().min(2).max(40);

export const createRoleSchema = z.object({
  name: roleName,
  permissions: z.array(permissionKey).max(200).default([]),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

/**
 * Both fields optional, but not both absent: an empty body is a caller that
 * meant something else. `permissions` is the **whole** set when present — a
 * partial grant edit would race two admins into a half-applied role.
 */
export const updateRoleSchema = z
  .object({
    name: roleName.optional(),
    permissions: z.array(permissionKey).max(200).optional(),
  })
  .refine((body) => body.name !== undefined || body.permissions !== undefined);
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

/** `PUT /auth/tenants/:tenantId/users/:userId/role` (F-1201-a): the whole of it is which role. */
export const assignRoleSchema = z.object({ roleId: z.string().uuid() });
export type AssignRoleInput = z.infer<typeof assignRoleSchema>;

/** The `:key` of `/auth/tenants/:tenantId/users/:userId/keys/:key` (AC-1-l): shape only. */
export const keyParamSchema = permissionKey;

/**
 * `PUT .../keys/:key` (AC-1-l): give or take, and why. The reason is
 * required — it is what staff read later, and what the audit row keeps.
 */
export const setKeySchema = z.object({
  effect: z.nativeEnum(UserPermissionEffect),
  reason: z.string().trim().min(3).max(500),
});
/** `Required`: both fields are mandatory in the schema; this project's non-strict inference reads them optional. */
export type SetKeyInput = Required<z.infer<typeof setKeySchema>>;
