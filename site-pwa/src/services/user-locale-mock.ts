"use server";

// TODO: این فایل کاملاً موقتیه — وقتی سیستم auth/DB واقعی ساخته شد،
// همین توابع رو با session واقعی و کوئری دیتابیس جایگزین کن.
// امضای توابع عمداً همینه که با نسخه‌ی واقعی هم سازگار بمونه.

const mockUserLocaleDB = new Map<string, string>(); // userId -> locale
mockUserLocaleDB.set("useruid", "en");

const mockUserThemeDB = new Map<string, string>(); // userId -> theme choice
mockUserThemeDB.set("useruid", "system");

export async function getCurrentUserId(): Promise<string | null> {
  // فعلا هیچ سشن واقعی نداریم
  return "useruid";
}

export async function getUserSavedLocale(
  userId: string,
): Promise<string | null> {
  return mockUserLocaleDB.get(userId) ?? null;
}

export async function saveUserLocale(
  userId: string,
  locale: string,
): Promise<void> {
  mockUserLocaleDB.set(userId, locale);
}

export async function getUserSavedTheme(
  userId: string,
): Promise<string | null> {
  return mockUserThemeDB.get(userId) ?? null;
}

export async function saveUserTheme(
  userId: string,
  theme: string,
): Promise<void> {
  mockUserThemeDB.set(userId, theme);
}
