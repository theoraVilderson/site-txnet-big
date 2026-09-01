"use client";

import { LocaleProvider } from "@/context/LocaleContext";
import type { LocaleMeta } from "@/context/LocaleContext";
import type { CompiledTranslation } from "@/stores/locale-store";
// 👈 تایپ را به جای layout از locale-store ایمپورت می‌کنیم

interface Props {
  children: React.ReactNode;
  initialLang: string;
  initialDir: "rtl" | "ltr";
  initialNamespaces: Record<string, Record<string, Record<string, CompiledTranslation>>>;
  initialAvailable: LocaleMeta[];
}

export function LocaleShell({
  children,
  initialLang,
  initialDir,
  initialNamespaces,
  initialAvailable,
}: Props) {
  return (
    <LocaleProvider
      initialLang={initialLang}
      initialDir={initialDir}
      initialNamespaces={initialNamespaces}
      initialAvailable={initialAvailable}
    >
      {children}
    </LocaleProvider>
  );
}
