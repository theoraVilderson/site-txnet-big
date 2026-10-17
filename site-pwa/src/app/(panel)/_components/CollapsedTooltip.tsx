"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The gap between the rail entry and its tooltip, in px (Tailwind `ms-3`). */
const TOOLTIP_GAP_PX = 12;

type Anchor = { top: number; inset: number; rtl: boolean };

/**
 * The label beside an icon-only rail entry; decorative, because the entry it
 * belongs to also carries the same words as `sr-only` text.
 *
 * Its own file rather than `PanelSidebar`'s, so the sidebar and the controls it
 * renders can both use it without importing each other (`LogoutButton` is a
 * child of the rail and needs the same tooltip its siblings get).
 *
 * Drawn in a portal at fixed coordinates, not as an absolute child: the rail
 * has to scroll on a short screen (settings and logout were pushed off it), and
 * a scroll container clips anything drawn outside its box.
 */
export function CollapsedTooltip({
  collapsed,
  label,
}: {
  collapsed: boolean;
  label: string;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    // The entry is the marker's parent — the element that used to be `group`.
    const host = marker.current?.parentElement;
    if (!collapsed || !host) return;
    const show = () => {
      const box = host.getBoundingClientRect();
      const rtl = getComputedStyle(host).direction === "rtl";
      const inset = rtl ? document.documentElement.clientWidth - box.left : box.right;
      setAnchor({ top: box.top + box.height / 2, inset: inset + TOOLTIP_GAP_PX, rtl });
    };
    const showOnKeyFocus = () => host.matches(":focus-visible") && show();
    const hide = () => setAnchor(null);
    host.addEventListener("pointerenter", show);
    host.addEventListener("pointerleave", hide);
    host.addEventListener("focusin", showOnKeyFocus);
    host.addEventListener("focusout", hide);
    // A scrolled rail moves the entry from under a tooltip fixed to the viewport.
    window.addEventListener("scroll", hide, true);
    return () => {
      host.removeEventListener("pointerenter", show);
      host.removeEventListener("pointerleave", hide);
      host.removeEventListener("focusin", showOnKeyFocus);
      host.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", hide, true);
      setAnchor(null);
    };
  }, [collapsed]);

  if (!collapsed) return null;
  return (
    <>
      <span ref={marker} hidden />
      {anchor &&
        createPortal(
          <span
            aria-hidden
            style={{ top: anchor.top, [anchor.rtl ? "right" : "left"]: anchor.inset }}
            className="pointer-events-none fixed z-50 hidden -translate-y-1/2 whitespace-nowrap rounded-lg border border-card-border bg-card-bg px-2 py-1 text-xs text-text-primary shadow-lg backdrop-blur-xl lg:block"
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}
