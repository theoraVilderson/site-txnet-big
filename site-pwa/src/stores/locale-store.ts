import { createStore } from "zustand/vanilla";
import { setUserLocale } from "@/services/locale";

export type CompiledTranslation = string | string[];

export interface LocaleMeta {
  code: string;
  name: string;
  shortName: string;
  englishName: string;
  dir: "rtl" | "ltr";
  locale: string;
}

// ۱. فقط دیتاها (استیت‌هایی که مقدار دارن و تابع نیستن)
// در LocaleShell فقط همین فیلدها پاس داده می‌شوند (به‌جز isTransitioning
// که همیشه false شروع می‌شه و نیازی نیست از بیرون پاس داده بشه)
export interface LocaleState {
  lang: string;
  isRtl: boolean;
  availableLocales: LocaleMeta[];
  /** کش ترجمه‌ها: lang → ns → key → CompiledTranslation */
  cache: Record<string, Record<string, Record<string, CompiledTranslation>>>;
  /** true وقتی یه setLang در حال fetch/commit شدنه — برای افکت بلور استفاده میشه */
  isTransitioning: boolean;
}

// ۲. فقط توابع (اکشن‌های تغییر دهنده استیت)
export interface LocaleActions {
  /** merge per-language namespaces into the cache: lang → ns → key → compiled */
  addNamespaces: (
    byLang: Record<string, Record<string, Record<string, CompiledTranslation>>>,
  ) => void;
  setLang: (newLang: string) => Promise<void>;
}

// ۳. ترکیب این دو برای ساختار نهایی استور (استفاده داخلی Zustand)
export type LocaleStore = LocaleState & LocaleActions;
export type LocaleStoreApi = ReturnType<typeof createLocaleStore>;

/**
 * تابع مسطح‌ساز و کامپایلر متون
 * برای زمانی که فایل زبان جدیدی از API فچ می‌شود یا سرور قصد تزریق دارد
 */
export function flattenAndCompile(
  obj: Record<string, any>,
  prefix = "",
): Record<string, CompiledTranslation> {
  return Object.keys(obj).reduce(
    (acc: Record<string, CompiledTranslation>, k: string) => {
      const pre = prefix.length ? prefix + "." : "";

      if (
        typeof obj[k] === "object" &&
        obj[k] !== null &&
        !Array.isArray(obj[k])
      ) {
        Object.assign(acc, flattenAndCompile(obj[k], pre + k));
      } else if (typeof obj[k] === "string") {
        const text = obj[k];

        // اگر متن شامل متغیر {{var}} بود، به آرایه توکن‌ها تبدیل می‌شود
        if (text.includes("{{")) {
          acc[pre + k] = text.split(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
        } else {
          acc[pre + k] = text;
        }
      }
      return acc;
    },
    {},
  );
}

// ۴. ایجاد استور: آرگومان ورودی از نوع LocaleState منهای isTransitioning است
// (اون فیلد داخلی استوره و همیشه با false شروع می‌شه)
export function createLocaleStore(initial: Omit<LocaleState, "isTransitioning">) {
  // این دو متغیر مخصوص همین instance از استوره (یعنی هر LocaleProvider
  // نسخه‌ی خودش رو داره، بین کاربرها/mount های مختلف قاطی نمی‌شه).
  //
  // مشکلی که حل می‌کنن: قبلاً اگه کاربر سریع زبان رو چند بار عوض می‌کرد
  // (مثلاً fa → en → fa با فاصله‌ی کم)، چند تا fetch async همزمان در
  // پرواز بودن و هرکدوم دیرتر resolve می‌شد state نهایی رو ست می‌کرد —
  // که لزوماً با آخرین کلیک کاربر یکی نبود.
  let latestRequestId = 0;
  let activeAbortController: AbortController | null = null;

  return createStore<LocaleStore>()((set, get) => ({
    // پخش کردن مقادیر اولیه (lang, isRtl, availableLocales, cache)
    ...initial,
    isTransitioning: false,

    // پیاده‌سازی اکشن‌ها
    addNamespaces: (byLang) =>
      set((state) => {
        const cache = { ...state.cache };
        for (const [lng, namespaces] of Object.entries(byLang)) {
          cache[lng] = { ...(cache[lng] || {}), ...namespaces };
        }
        return { cache };
      }),

    setLang: async (newLang: string) => {
      const { lang, cache, availableLocales } = get();
      if (newLang === lang) return;

      // اگه یه setLang دیگه در حال fetch بود، abortش کن — نتیجه‌ش دیگه
      // به دردی نمی‌خوره چون کاربر زبان دیگه‌ای انتخاب کرده
      activeAbortController?.abort();
      const requestId = ++latestRequestId;
      const controller = new AbortController();
      activeAbortController = controller;

      set({ isTransitioning: true });

      let namespaces = cache[newLang];
      let dir: "rtl" | "ltr";

      try {
        if (namespaces) {
          // از کش می‌خوانیم — نیازی به فچ نیست
          dir = availableLocales.find((m) => m.code === newLang)?.dir ?? "ltr";
        } else {
          const metaRes = await fetch(`/api/i18n/meta`, {
            signal: controller.signal,
          });
          if (metaRes.ok) {
            const { meta } = await metaRes.json();
            dir = meta?.[newLang]?.dir === "rtl" ? "rtl" : "ltr";
          } else {
            dir = "ltr";
          }

          namespaces = {};
          const nsList = Object.keys(cache[lang] ?? {});

          await Promise.all(
            nsList.map(async (ns) => {
              try {
                const res = await fetch(`/api/i18n/${newLang}/${ns}`, {
                  signal: controller.signal,
                });
                if (res.ok) {
                  // دیتای دریافتی را در همان لحظه مسطح و کامپایل می‌کنیم
                  namespaces![ns] = flattenAndCompile(await res.json());
                }
              } catch {
                /* این namespace را رد کن (شامل abort شدن هم می‌شه) */
              }
            }),
          );

          if (Object.keys(namespaces).length === 0) {
            // چیزی لود نشد — اگه هنوز جدیدترین درخواست هستیم، overlay رو ببند
            if (requestId === latestRequestId) set({ isTransitioning: false });
            return;
          }
        }
      } catch {
        // خطای شبکه یا abort — اگه هنوز جدیدترین درخواست هستیم overlay رو ببند
        if (requestId === latestRequestId) set({ isTransitioning: false });
        return;
      }

      // اگه در این فاصله یه setLang جدیدتر صدا زده شده، این نتیجه‌ی
      // قدیمی/دیررسیده رو نادیده بگیر و state رو باهاش commit نکن
      if (requestId !== latestRequestId) return;

      // دیتا معمولاً از قبل کش شده و این‌جا فوری می‌رسیم. برای اینکه سوییچ
      // «پرشی» نباشه، صبر می‌کنیم بلورِ overlay کامل بشینه، بعد متن + جهت
      // (rtl/ltr) رو زیر بلور عوض می‌کنیم، یه لحظه نگه می‌داریم تا reflow
      // تموم بشه، بعد overlay محو می‌شه و متنِ جدید نرم ظاهر می‌شه.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      await sleep(200);
      if (requestId !== latestRequestId) return;
      set((state) => ({
        lang: newLang,
        isRtl: dir === "rtl",
        cache: { ...state.cache, [newLang]: namespaces! },
      }));

      await sleep(90);
      if (requestId !== latestRequestId) return;
      set({ isTransitioning: false });

      setUserLocale(newLang).catch(() => {
        // خطای شبکه/سرور نباید تجربه کاربر را خراب کند؛
        // زبان همچنان در همین سشن تغییر می‌کند، فقط در کوکی پایدار نمی‌ماند
      });
    },
  }));
}