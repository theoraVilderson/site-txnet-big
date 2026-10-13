import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./fonts.css";
import { getUserLocale } from "@/services/locale";
import { getServerTheme } from "@/services/theme";
import {
  getDir,
  getAvailableLocales,
  getLocaleMeta,
  ensureReady,
  getCompiledNamespace,
  type LocaleMeta,
} from "@/lib/locale-catalog";
import { startWatching } from "@/lib/locale-watcher";
import { LocaleShell } from "@/context/LocaleShell";
import { ThemeProvider } from "@/context/ThemeContext";
import { THEME_SCRIPT } from "@/lib/theme-script";
import { MOTION_SCRIPT } from "@/lib/motion";
import { BrandProvider } from "@/context/BrandContext";
import { brandStyle, fetchBranding } from "@/lib/branding";
import { visitorHost } from "@/lib/visitor-host";

/**
 * The domain's brand (F-066-v): read by the host the visitor is on, never by
 * session, so a reseller's owner signed in on the reseller's domain sees the
 * reseller's brand (ADR-0059). `fetchBranding` caches per host.
 */
async function domainBrand() {
  const host = visitorHost(await headers());
  const brand = host ? await fetchBranding(host) : null;
  return { brand, fallbackName: host ?? "" };
}

export async function generateMetadata(): Promise<Metadata> {
  const { brand, fallbackName } = await domainBrand();
  const name = brand?.brandName || fallbackName;
  return {
    title: name,
    ...(brand?.faviconUrl ? { icons: { icon: brand.faviconUrl } } : {}),
    ...(brand?.ogImageUrl
      ? { openGraph: { title: name, images: [brand.ogImageUrl] } }
      : {}),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 1. The language catalog is in server memory and its watcher is running.
  await ensureReady(startWatching);

  // 2. The visitor's language and theme.
  const locale = await getUserLocale();
  const dir = getDir(locale);
  const { theme, isResolved, choice } = await getServerTheme();
  const brand = await domainBrand();

  // 3. Every language's metadata, for the language picker.
  const available = getAvailableLocales();
  const metaList: LocaleMeta[] = [];
  for (const code of available) {
    const m = getLocaleMeta(code);
    if (m) metaList.push(m);
  }

  // 4. The shared namespaces, compiled here for *every* language. Every
  // language is already in the server's gRPC cache, so this is nearly free,
  // and it makes a language switch on the client instant (no fetch).
  // Route-specific namespaces such as auth load in their own layout (again
  // for every language).
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
      style={brandStyle(brand.brand)}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: MOTION_SCRIPT }} />
      </head>
      <body className="transition-colors duration-300">
        <ThemeProvider initialTheme={theme} initialChoice={choice}>
          <BrandProvider value={brand}>
            <LocaleShell
              initialLang={locale}
              initialDir={dir}
              initialNamespaces={initialNamespaces}
              initialAvailable={metaList}
            >
              {children}
            </LocaleShell>
          </BrandProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
