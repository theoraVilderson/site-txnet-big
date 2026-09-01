"use server";
import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE } from "@/env";
import { getAvailableLocales, ensureReady } from "@/lib/locale-store";
import { startWatching } from "@/lib/locale-watcher";
import {
  getCurrentUserId,
  getUserSavedLocale,
  saveUserLocale,
} from "./user-locale-mock";

export async function getUserLocale() {
  await ensureReady(startWatching);

  // ۱. اولویت اول: زبان ذخیره‌شده برای کاربرِ لاگین‌کرده (فعلا موک)
  const userId = await getCurrentUserId();
  if (userId) {
    const dbLocale = await getUserSavedLocale(userId);
    if (dbLocale) return dbLocale;
  }

  // ۲. انتخاب دستی قبلی کاربر (کوکی)
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (localeCookie) return localeCookie;

  // ۳. تشخیص خودکار از Accept-Language — روی لیست دینامیک زبان‌های موجود
  const available = getAvailableLocales();
  const headersList = await headers();
  const acceptLanguage = headersList.get("accept-language");
  if (acceptLanguage) {
    for (const code of available) {
      if (acceptLanguage.includes(code)) return code;
    }
  }

  // ۴. پیش‌فرض
  return DEFAULT_LOCALE;
}

export async function setUserLocale(locale: string) {
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    maxAge: 60 * 60 * 24 * 365,
  });

  // اگر کاربر لاگین است، توی «دیتابیس» (فعلا موک) هم ذخیره کن تا بین دستگاه‌ها سینک بمونه
  const userId = await getCurrentUserId();
  if (userId) {
    await saveUserLocale(userId, locale);
  }
}
