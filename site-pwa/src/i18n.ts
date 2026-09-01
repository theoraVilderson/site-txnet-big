import "server-only";

/**
 * این بشکه فقط برای مصرف داخل Server Component ها است.
 * هیچ فایل "use client" نباید از اینجا import کند.
 *
 * توجه: getUserLocale/setUserLocale عمداً اینجا export نمی‌شوند —
 * آن‌ها یک Server Action هستند ("use server" در services/locale.ts)
 * و اگر کنار توابع sync در همین بشکه export شوند، Turbopack کل این
 * فایل را یک ماژول Server Actions فرض می‌کند و انتظار async بودن
 * همه‌ی توابع (از جمله getDir) را دارد. هر جا لازم بود مستقیماً از
 * "@/services/locale" ایمپورت کن.
 */
export { DEFAULT_LOCALE, LOCALE_COOKIE } from "./env";
export {
  initStore,
  reloadStore,
  getNamespace,
  getStore,
  getVersion,
  isInitialized,
  ensureReady,
  getLocaleMeta,
  getAvailableLocales,
  getDir,
} from "./lib/locale-store";
export type { LocaleMeta } from "./lib/locale-store";
export { startWatching } from "./lib/locale-watcher";
