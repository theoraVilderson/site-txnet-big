/**
 * ==========================================================================
 * سیستم مشترک استخراج تایپ ترجمه‌ها از روی JSON — برای همه‌ی namespace ها
 * ==========================================================================
 *
 * فلسفه: به‌جای اینکه برای هر namespace (auth, dashboard, billing, ...)
 * دستی یه interface بنویسیم و بعد نگرانِ sync موندنش با JSON واقعی باشیم،
 * تایپ رو مستقیماً از روی خودِ فایل JSON زبان مرجع (fa) استخراج می‌کنیم.
 *
 * نتیجه: اگه یه کلید رو از fa/xxx.json پاک کنی یا اسمش رو عوض کنی، همون
 * لحظه هر جای کد که ازش استفاده کرده بودی build-error می‌گیره. دیگه لازم
 * نیست دستی دو جا (JSON + interface) رو sync نگه داری.
 *
 * محدودیت مهم: این فقط shape (اسم کلیدها) رو از JSON فارسی می‌گیره، نه
 * محتوا. یعنی اگه یه کلید توی fa/auth.json باشه ولی توی en/auth.json
 * فراموش بشه، TypeScript چیزی نمی‌گه — چون در حد نوع، هر دو JSON فقط باید
 * "یه string" برگردونن. این یه گلوگاه runtime باقی می‌مونه، نه compile-time.
 * (اگه لازم شد، می‌شه یه اسکریپت CI برای چک کردن این مورد نوشت — جدا از این فایل.)
 */

/**
 * برای namespace های flat (بدون nesting) — یعنی اکثر namespace های این
 * پروژه، مثل auth.json که مستقیماً { loginTitle: "...", phone: "...", ... }ه.
 *
 * استفاده:
 *   import type authFa from "@/locales/langs/frontend/langs/fa/auth.json";
 *   export type AuthTranslations = TranslationShape<typeof authFa>;
 */
export type TranslationShape<T extends Record<string, unknown>> = {
  [K in keyof T]: string;
};

/**
 * برای namespace هایی که JSON‌شون nested باشه، مثل:
 *   { profile: { title: "...", subtitle: "..." } }
 * که runtime (flattenAndCompile در stores/locale-store.ts) به شکل
 * dot-notation فلت‌شون می‌کنه: "profile.title", "profile.subtitle".
 *
 * این تایپ همون منطق فلت‌کردن رو در سطح type-system بازسازی می‌کنه تا
 * کلیدهای دات‌دار هم autocomplete/type-check داشته باشن.
 *
 * فقط وقتی لازمشی که واقعاً از JSON تو در تو استفاده کردی — اگه namespace
 * جدیدت مثل بقیه flat باشه، همون TranslationShape ساده کافیه.
 *
 * استفاده:
 *   import type dashboardFa from "@/locales/langs/frontend/langs/fa/dashboard.json";
 *   export type DashboardTranslations = FlattenTranslationShape<typeof dashboardFa>;
 */
type DotPrefix<T extends string> = T extends "" ? "" : `.${T}`;

type DotNestedKeys<T> =
  T extends Record<string, unknown>
    ? {
        [K in Extract<keyof T, string>]: `${K}${DotPrefix<
          DotNestedKeys<T[K]>
        >}`;
      }[Extract<keyof T, string>]
    : "";

export type FlattenTranslationShape<T extends Record<string, unknown>> = Record<
  DotNestedKeys<T>,
  string
>;
