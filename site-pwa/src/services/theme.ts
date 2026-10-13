"use server";

import { cookies } from "next/headers";
import { DEFAULT_THEME, THEME_COOKIE, type ThemeName } from "@/env";
import { isThemeName, type ThemeChoice } from "@/lib/theme";
import {
  getCurrentUserId,
  getUserSavedTheme,
  saveUserTheme,
} from "./user-locale-mock";

/** The theme cookie lives a year; a choice is re-saved on every switch. */
const THEME_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

export interface ServerThemeResult {
  /** The theme rendered on the server's HTML. */
  theme: ThemeName;
  /** True when settled (account or cookie); false means "system", left to the client. */
  isResolved: boolean;
  /** The raw choice, seeded into the client store. */
  choice: ThemeChoice;
}

/**
 * Precedence: the account's saved theme, then the cookie, then the system.
 * The server cannot see the OS preference, so that last case returns
 * isResolved=false and the inline script settles it before paint.
 */
export async function getServerTheme(): Promise<ServerThemeResult> {
  const userId = await getCurrentUserId();
  if (userId) {
    const saved = await getUserSavedTheme(userId);
    if (isThemeName(saved)) {
      return { theme: saved, isResolved: true, choice: saved };
    }
  }

  const cookieStore = await cookies();
  const cookieVal = cookieStore.get(THEME_COOKIE)?.value;
  if (isThemeName(cookieVal)) {
    return { theme: cookieVal, isResolved: true, choice: cookieVal };
  }

  return { theme: DEFAULT_THEME, isResolved: false, choice: "system" };
}

export async function setUserTheme(choice: ThemeChoice) {
  const cookieStore = await cookies();
  cookieStore.set(THEME_COOKIE, choice, { maxAge: THEME_COOKIE_MAX_AGE_S });

  const userId = await getCurrentUserId();
  if (userId) {
    // "system" is saved too, so the next visit follows the OS again.
    await saveUserTheme(userId, choice);
  }
}
