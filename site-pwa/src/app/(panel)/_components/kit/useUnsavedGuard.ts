"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useConfirm } from "./confirm";

const K = FrontendI18nKeys.common.kit.unsaved;

/**
 * While `dirty`, leaving the page asks first (UX-1-e, `contract.ux.md` K11):
 * a click on an in-app link is held and asked about through `useConfirm`
 * (`default` tone, K9), and a reload or a closed tab gets the browser's own
 * `beforeunload` question — the only one a browser allows there.
 *
 * Links are caught at the document in the capture phase, before Next's `Link`
 * sees the click. A `router.push` from code is not a link: the code that
 * pushes while a form is dirty asks with `confirmLeave()` first.
 */
export function useUnsavedGuard(dirty: boolean): { confirmLeave: () => Promise<boolean> } {
  const { t } = useLocale();
  const confirm = useConfirm();
  const router = useRouter();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const confirmLeave = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return confirm({ title: t("common", K.title), body: t("common", K.body), confirmLabel: t("common", K.leave), tone: "default" });
  }, [confirm, t]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      void confirmLeave().then((leave) => {
        if (leave) router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, confirmLeave, router]);

  return { confirmLeave };
}
