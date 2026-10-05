"use client";

import { AnimatePresence, motion } from "framer-motion";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";

/** A navigation that has not landed by then has failed or been abandoned. */
const GIVE_UP_MS = 10_000;

/**
 * A thin bar across the top while a route loads (UX-1-i, `contract.ux.md` M4).
 * The App Router has no navigation events, so it starts on a click on a link
 * to another page of this origin, and ends when the path or query changes —
 * the address the click was made on is the one it waits to leave. A click
 * something else already handled (`useUnsavedGuard` asking first) starts nothing.
 */
export function RouteProgress() {
  const { t } = useLocale();
  const level = useMotionLevel();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = `${pathname}?${search}`;
  const [leaving, setLeaving] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      setLeaving(`${window.location.pathname}?${window.location.search.replace(/^\?/, "")}`);
      clearTimeout(timer);
      timer = setTimeout(() => setLeaving(null), GIVE_UP_MS);
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      clearTimeout(timer);
    };
  }, []);

  const loading = leaving === here;
  const reduced = level === "reduced";
  return (
    <AnimatePresence>
      {loading && (
        <motion.div
          key="route-progress"
          role="progressbar"
          aria-label={t("common", FrontendI18nKeys.common.shell.progress)}
          className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5 origin-left bg-primary shadow-[0_0_8px_var(--accent-primary)] rtl:origin-right"
          initial={reduced ? { opacity: 0 } : { scaleX: 0, opacity: 1 }}
          animate={reduced ? { opacity: 1 } : { scaleX: 0.85, opacity: 1, transition: { duration: 6, ease: [0.1, 0.7, 0.2, 1] } }}
          exit={reduced ? { opacity: 0, transition: { duration: DURATION.fast } } : { scaleX: 1, opacity: 0, transition: { duration: DURATION.slow, ease: EASE.exit } }}
        />
      )}
    </AnimatePresence>
  );
}
