import { AVAILABLE_THEMES, type ThemeName } from "@/env";

/**
 * Pure theme rules shared by the client store, the server read and the
 * pre-paint script (FE-1-e). Neutral on purpose: a "use server" module cannot
 * export a sync helper and a "use client" one hands the server a reference.
 */

/** What the user picked; "system" is resolved against the OS on the client. */
export type ThemeChoice = ThemeName | "system";

/** The media query every "system" resolution asks — script, store and listener. */
export const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

/** True for a configured theme; "system" is a choice, not a theme. */
export function isThemeName(v: string | null | undefined): v is ThemeName {
  return !!v && (AVAILABLE_THEMES as readonly string[]).includes(v);
}

/** The theme a choice paints: "system" follows the OS, anything else is kept. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ThemeName {
  if (choice !== "system") return choice;
  return prefersDark ? "dark" : "light";
}

/** The OS preference, false where there is no window (server render). */
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(PREFERS_DARK_QUERY).matches;
}
