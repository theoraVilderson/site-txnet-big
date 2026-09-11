"use server";

// TODO: این فایل کاملاً موقتیه — وقتی سیستم auth/DB واقعی ساخته شد،
// همین توابع رو با session واقعی و کوئری دیتابیس جایگزین کن.
// امضای توابع عمداً همینه که با نسخه‌ی واقعی هم سازگار بمونه.

// NOTE (F-068): these maps are module-level, so in a server process they are
// shared by every visitor at once, not per-user. That is tolerable only while
// nothing writes a value anyone else can read — which is why neither map is
// seeded any more. When the real session lands, this whole file goes with it.
const mockUserLocaleDB = new Map<string, string>(); // userId -> locale

const mockUserThemeDB = new Map<string, string>(); // userId -> theme choice

export async function getCurrentUserId(): Promise<string | null> {
  // There is no real session yet, so the honest answer is "nobody".
  //
  // This used to return a fixed `"useruid"` unconditionally, with that user
  // seeded to `"en"` above — and since the signed-in account's language is
  // rank 1 in `getUserLocale`, every anonymous visitor was answered in English
  // before the `NEXT_LOCALE` cookie or `DEFAULT_LANGUAGE` was ever reached.
  // It survived the obvious greps because the language was a `.set()`
  // argument, not a default. Returning null is what lets the documented
  // precedence in `panel-web/contract.md` actually run.
  //
  // `getServerTheme` reads this too and is unaffected: its seed was "system",
  // which is not a `ThemeName`, so it already fell through to the cookie.
  return null;
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
