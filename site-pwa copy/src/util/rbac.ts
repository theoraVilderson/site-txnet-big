// lib/rbac.ts
import { ROLE_PERMISSIONS } from "@/configs/permissions";
import { UserRoles } from "@/types/user";
import { Permissions } from "@/types/permission";

/**
 * بررسی می‌کند که آیا نقش کاربر دارای پرمیشن درخواستی هست یا خیر
 */
export function hasPermission(
  userRoles: UserRoles[],
  requiredPermission: Permissions
): boolean {
  // اگر کاربر هیچ نقشی ندارد
  if (!userRoles || userRoles.length === 0) return false;

  // بررسی تمامی نقش‌های کاربر (چون کاربر ممکن است هم ADMIN باشد هم SUPPORT)
  for (const role of userRoles) {
    const permissions = ROLE_PERMISSIONS[role];
    if (permissions && permissions.includes(requiredPermission)) {
      return true;
    }
  }

  return false;
}
