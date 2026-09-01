import { AuthUIProvider } from "@auth/auth/_context/AuthUIContext";
import { AuthNav } from "@auth/auth/_components/AuthNav";
import { NamespaceInjector } from "@/components/NamespaceInjector";
import {
  getCompiledNamespace,
  getAvailableLocales,
  ensureReady,
} from "@/lib/locale-store";
import { startWatching } from "@/lib/locale-watcher";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await ensureReady(startWatching);


  // `auth` namespace compiled for EVERY language — so switching language on an
  // auth page is instant (no fetch) and SSR has the right strings immediately.
  const authByLang: Record<string, Record<string, unknown>> = {};
  for (const code of getAvailableLocales()) {
    authByLang[code] = getCompiledNamespace(code, "auth");
  }

  const injectPayload = Object.fromEntries(
    Object.entries(authByLang).map(([lng, ns]) => [lng, { auth: ns }]),
  );

  return (
    <AuthUIProvider authByLang={authByLang as never}>
      {/* also mirrored into the store so client-side language switching and any
          other `useLocale().t("auth", …)` callers keep working */}
      <NamespaceInjector namespaces={injectPayload as never} />
      <div className="min-h-screen w-full flex flex-col relative overflow-hidden transition-colors duration-500">
        <AuthNav />
        <div className="flex-1 flex items-top justify-center relative z-10 w-full">
          <div className="wellness-card w-full flex items-center max-w-[440px]">
            <div className="organic-border w-full" />
            {children}
          </div>
        </div>
      </div>
    </AuthUIProvider>
  );
}
