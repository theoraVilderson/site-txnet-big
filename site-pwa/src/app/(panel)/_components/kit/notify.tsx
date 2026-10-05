"use client";

import { Info } from "lucide-react";
import { useEffect } from "react";
import toast, { Toaster, useToasterStore, type Renderable } from "react-hot-toast";
import { useLocale } from "@/context/LocaleContext";
import { MD_UP, useMediaQuery } from "./overlay";

/** K10: long enough to read once; an error longer, since it may need acting on. */
export const TOAST_MS = { success: 4_000, info: 4_000, error: 6_000 } as const;
/** K10: more than this and the oldest goes — a burst of failures must not bury the page. */
export const TOAST_LIMIT = 3;

const POLITE = { role: "status", "aria-live": "polite" } as const;
const ASSERTIVE = { role: "alert", "aria-live": "assertive" } as const;

/**
 * The panel's toasts (UX-1-e, `contract.ux.md` K10), over `react-hot-toast`.
 * A toast reports an action that has no form — a delete, a copy, a toggle, a
 * save that succeeded. A form's own error stays inline in its `Field` (K4).
 * Nothing calls `react-hot-toast` but this file.
 */
export const notify = {
  success: (message: Renderable) => toast.success(message, { duration: TOAST_MS.success, ariaProps: POLITE }),
  info: (message: Renderable) =>
    toast(message, { duration: TOAST_MS.info, ariaProps: POLITE, icon: <Info size={18} aria-hidden className="shrink-0 text-info" /> }),
  error: (message: Renderable) => toast.error(message, { duration: TOAST_MS.error, ariaProps: ASSERTIVE }),
  /** One toast that turns from "working…" into the outcome. */
  promise: <T,>(work: Promise<T>, messages: { loading: Renderable; success: Renderable | ((value: T) => Renderable); error: Renderable | ((e: unknown) => Renderable) }) =>
    toast.promise(work, messages, {
      loading: { ariaProps: POLITE },
      success: { duration: TOAST_MS.success, ariaProps: POLITE },
      error: { duration: TOAST_MS.error, ariaProps: ASSERTIVE },
    }),
  dismiss: (id?: string) => toast.dismiss(id),
};

/**
 * Where toasts are drawn, mounted once at the panel layout: bottom-centre
 * below `md`, the bottom end corner above it, in the theme's colours.
 */
export function PanelToaster() {
  const { isRtl } = useLocale();
  const wide = useMediaQuery(MD_UP);
  const { toasts } = useToasterStore();

  // The store keeps the newest first; anything past the limit is dismissed,
  // which lets it animate out rather than vanish.
  useEffect(() => {
    toasts
      .filter((t) => t.visible)
      .slice(TOAST_LIMIT)
      .forEach((t) => toast.dismiss(t.id));
  }, [toasts]);

  return (
    <Toaster
      position={wide ? (isRtl ? "bottom-left" : "bottom-right") : "bottom-center"}
      gutter={8}
      containerStyle={{ inset: 16, zIndex: 70 }}
      toastOptions={{
        className: "!rounded-2xl !border !border-card-border !bg-card-bg !text-text-primary !shadow-xl !text-sm !px-3.5 !py-2.5 !max-w-sm",
        success: { iconTheme: { primary: "var(--success)", secondary: "var(--card-bg)" } },
        error: { iconTheme: { primary: "var(--error-color)", secondary: "var(--card-bg)" } },
      }}
    />
  );
}
