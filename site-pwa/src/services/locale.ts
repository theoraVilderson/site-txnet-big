"use server";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE } from "@/env";
import { ensureReady } from "@/lib/locale-catalog";
import { startWatching } from "@/lib/locale-watcher";
import {
  getCurrentUserId,
  getUserSavedLocale,
  saveUserLocale,
} from "./user-locale-mock";

export async function getUserLocale() {
  await ensureReady(startWatching);

  // 1. The signed-in account's saved language (mocked until a session exists).
  const userId = await getCurrentUserId();
  if (userId) {
    const dbLocale = await getUserSavedLocale(userId);
    if (dbLocale) return dbLocale;
  }

  // 2. The language the visitor picked before (the cookie).
  const cookieStore = await cookies();
  const localeCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (localeCookie) return localeCookie;

  // 3. The deployment's language. Nothing below this line: the browser's
  //    `Accept-Language` used to be consulted here and is deliberately not,
  //    which is the whole of F-068. A Persian deployment answers an English
  //    browser in Persian, the same rule `ChatLanguage` follows for the bot
  //    (F-046, ADR-0016) — the header is a guess about the person, while
  //    `DEFAULT_LANGUAGE` is a statement about the deployment, and the two
  //    choices above are the person actually saying so.
  return DEFAULT_LOCALE;
}

export async function setUserLocale(locale: string) {
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    maxAge: 60 * 60 * 24 * 365,
  });

  // Signed in: save it on the account too (mocked), so it follows them across devices.
  const userId = await getCurrentUserId();
  if (userId) {
    await saveUserLocale(userId, locale);
  }
}
