/**
 * Shared environment configuration — single source of truth.
 * Import this everywhere instead of scattering process.env reads.
 */

/** زبان پیش‌فرض — فقط اینجا عوض کن، همه‌جا تغییر می‌کنه */
export const DEFAULT_LOCALE = "fa" as const;

/** Where locale JSON files live inside the container (legacy; only locale-service reads them now) */
export const LOCALES_DIR = process.env.LOCALES_DIR || "./locales/langs";

/** Enable file watcher for hot-reload in dev (legacy; live reload now comes from locale-service) */
export const LOCALES_WATCH = process.env.LOCALES_WATCH === "true";

/** locale-service gRPC address (source of truth for translations) */
export const LOCALE_SERVICE_ADDR =
  process.env.LOCALE_SERVICE_ADDR || "localhost:50051";

/** Which slice of the locale tree this app needs */
export const LOCALE_SCOPE = process.env.LOCALE_SCOPE || "frontend";

/** Cookie name for user's locale preference */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** لیست تم‌های موجود — هر تم جدید فقط اینجا و در globals.css اضافه می‌شه */
export const AVAILABLE_THEMES = ["light", "dark", "ocean"] as const;
export type ThemeName = (typeof AVAILABLE_THEMES)[number];
export const DEFAULT_THEME: ThemeName = "dark";
export const THEME_COOKIE = "NEXT_THEME";
