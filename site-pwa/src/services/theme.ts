"use server";

import { cookies } from "next/headers";
import {
  AVAILABLE_THEMES,
  DEFAULT_THEME,
  THEME_COOKIE,
  type ThemeName,
} from "@/env";
import {
  getCurrentUserId,
  getUserSavedTheme,
  saveUserTheme,
} from "./user-locale-mock";

export type ThemeChoice = ThemeName | "system";

export interface ServerThemeResult {
  /** تمی که باید بلافاصله روی HTML سرور رندر بشه */
  theme: ThemeName;
  /** true یعنی این مقدار قطعیه (از اکانت یا کوکی)، false یعنی «سیستم» و کلاینت باید نهایی‌اش کنه */
  isResolved: boolean;
  /** انتخاب خام کاربر، برای پاس دادن به استور کلاینت */
  choice: ThemeChoice;
}

function isThemeName(v: string | null | undefined): v is ThemeName {
  return !!v && (AVAILABLE_THEMES as readonly string[]).includes(v);
}

/**
 * اولویت: ۱) تم ذخیره‌شده روی اکانت کاربر  ۲) کوکی  ۳) پیش‌فرض سیستم.
 * حالت سوم روی سرور قابل تشخیص نیست (نیاز به matchMedia کلاینت داره)،
 * پس isResolved=false برمی‌گردونیم تا فقط اون حالت با اسکریپت inline حل بشه.
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
  cookieStore.set(THEME_COOKIE, choice, { maxAge: 60 * 60 * 24 * 365 });

  const userId = await getCurrentUserId();
  if (userId) {
    // "system" هم عمداً ذخیره می‌شه تا دفعه بعد دوباره از سیستم پیروی کنه
    await saveUserTheme(userId, choice);
  }
}
