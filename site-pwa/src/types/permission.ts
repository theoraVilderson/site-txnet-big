// types/permissions.ts

export enum Permissions {
  // --- مدیریت کاربران ---
  USERS_VIEW = "USERS_VIEW", // مشاهده لیست کاربران
  USERS_CREATE = "USERS_CREATE", // ساخت کاربر دستی
  USERS_EDIT = "USERS_EDIT", // ویرایش اطلاعات کاربر
  USERS_CHANGE_STATUS = "USERS_CHANGE_STATUS", // مسدود/فعال کردن کاربر

  // --- مدیریت سرورهای VPN ---
  SERVERS_VIEW = "SERVERS_VIEW", // مشاهده لیست سرورها
  SERVERS_CREATE = "SERVERS_CREATE", // افزودن سرور جدید
  SERVERS_EDIT = "SERVERS_EDIT", // ویرایش مشخصات سرور
  SERVERS_DELETE = "SERVERS_DELETE", // حذف سرور
  SERVERS_REBOOT = "SERVERS_REBOOT", // ریستارت کردن سرور از پنل
  SERVERS_CONFIG_VIEW = "SERVERS_CONFIG_VIEW", // دیدن کانفیگ‌های محرمانه (X-UI/Wireguard)

  // --- مالی و تراکنش‌ها ---
  FINANCE_VIEW_TRANSACTIONS = "FINANCE_VIEW_TRANSACTIONS",
  FINANCE_MANAGE_PLANS = "FINANCE_MANAGE_PLANS", // قیمت‌گذاری پلن‌ها
  FINANCE_REFUND = "FINANCE_REFUND", // قابلیت عودت وجه

  // --- سیستم تیکتینگ ---
  TICKETS_VIEW_ALL = "TICKETS_VIEW_ALL", // دیدن همه تیکت‌ها
  TICKETS_REPLY = "TICKETS_REPLY", // پاسخ دادن
  TICKETS_CLOSE = "TICKETS_CLOSE", // بستن تیکت

  // --- داشبورد و گزارشات ---
  DASHBOARD_VIEW_STATS = "DASHBOARD_VIEW_STATS", // دیدن نمودارهای فروش و مصرف
}
