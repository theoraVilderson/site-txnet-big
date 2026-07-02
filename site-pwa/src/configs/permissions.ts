// config/rolePermissions.ts
import { UserRoles } from "@/types/user";
import { Permissions } from "@/types/permission";

export const ROLE_PERMISSIONS: Record<UserRoles, Permissions[]> = {
  [UserRoles.USER]: [], // کاربر عادی معمولاً پرمیشن مدیریتی ندارد

  [UserRoles.VIP]: [],

  [UserRoles.AGENT]: [
    Permissions.USERS_CREATE, // ایجنت می‌تواند برای زیرمجموعه‌اش کاربر بسازد
    Permissions.FINANCE_VIEW_TRANSACTIONS, // دیدن درآمد خودش
  ],

  [UserRoles.SUPPORT]: [
    Permissions.USERS_VIEW,
    Permissions.USERS_CHANGE_STATUS,
    Permissions.TICKETS_VIEW_ALL,
    Permissions.TICKETS_REPLY,
    Permissions.TICKETS_CLOSE,
    Permissions.SERVERS_VIEW, // فقط ببیند سرور آپ است یا نه
  ],

  [UserRoles.ADMIN]: [
    Permissions.USERS_VIEW,
    Permissions.USERS_EDIT,
    Permissions.SERVERS_VIEW,
    Permissions.SERVERS_REBOOT,
    Permissions.FINANCE_MANAGE_PLANS,
    Permissions.DASHBOARD_VIEW_STATS,
  ],

  [UserRoles.MANAGER]: Object.values(Permissions), // دسترسی کامل به همه چیز
};
