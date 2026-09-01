import type { Metadata } from "next";
import "./globals.css";
import "./fonts.css";
import { getUserLocale } from "@/services/locale";
import { getServerTheme } from "@/services/theme";
import {
  getDir,
  getAvailableLocales,
  getLocaleMeta,
  ensureReady,
  getCompiledNamespace, // 👈 این متد جدید را از استور ایمپورت کردیم
  type LocaleMeta,
} from "@/lib/locale-store";
import { startWatching } from "@/lib/locale-watcher";
import { LocaleShell } from "@/context/LocaleShell";
import { ThemeShell } from "@/context/ThemeShell";
import { THEME_SCRIPT } from "@/lib/theme-script";

export const metadata: Metadata = {
  title: "تکسنت - txnet",
  description: "پنل کاربری تکسنت",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // ۱. اطمینان از لود شدن فایل‌های زبان در مموری سرور و استارت شدن واچر
  await ensureReady(startWatching);

  // ۲. دریافت تنظیمات زبان و تم کاربر
  const locale = await getUserLocale();
  const dir = getDir(locale);
  const { theme, isResolved, choice } = await getServerTheme();

  // ۳. جمع‌آوری متادیتای تمام زبان‌ها برای استفاده در منوی Dropdown
  const available = getAvailableLocales();
  const metaList: LocaleMeta[] = [];
  for (const code of available) {
    const m = getLocaleMeta(code);
    if (m) metaList.push(m);
  }

  // ۴. namespace های عمومی را برای *همه‌ی* زبان‌ها اینجا کامپایل می‌کنیم.
  // چون هر سه زبان از قبل در کش gRPC سرور هستند این کار تقریباً رایگان است،
  // ولی باعث می‌شود سوییچ زبان در کلاینت *فوری* باشد (بدون هیچ fetch).
  // namespace های اختصاصی مثل auth در Layout خودشان (باز هم برای همه‌ی زبان‌ها) لود می‌شوند.
  const initialNamespaces: Record<
    string,
    Record<string, Record<string, string | string[]>>
  > = {};
  for (const code of available) {
    initialNamespaces[code] = {
      common: getCompiledNamespace(code, "common"),
      validations: getCompiledNamespace(code, "validations"),
    };
  }

  return (
    <html
      lang={locale}
      dir={dir}
      data-theme={theme}
      {...(isResolved ? { "data-theme-resolved": "true" } : {})}
      className={theme === "dark" ? "dark" : undefined}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="transition-colors duration-300">
        <ThemeShell initialTheme={theme} initialChoice={choice}>
          <LocaleShell
            initialLang={locale}
            initialDir={dir}
            initialNamespaces={initialNamespaces} // ارسال دیتاهای عمومی به کلاینت
            initialAvailable={metaList}
          >
            {children}
          </LocaleShell>
        </ThemeShell>
      </body>
    </html>
  );
}
