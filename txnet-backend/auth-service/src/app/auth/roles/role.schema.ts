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
