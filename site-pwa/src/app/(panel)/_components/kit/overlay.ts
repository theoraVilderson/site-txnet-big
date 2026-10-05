"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";

/**
 * What every kit overlay shares (UX-1-d, `contract.ux.md` K7): a stack so Esc
 * closes only the topmost, a focus trap, a body scroll lock counted across
 * overlays, and focus returned to whatever held it before the overlay opened.
 */

const stack: number[] = [];
let nextId = 1;
let locks = 0;
let saved: { overflow: string; paddingRight: string } | null = null;

function lockScroll() {
  if (locks++ > 0) return;
  const body = document.body;
  saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
  // The scrollbar's width, kept as padding, so the page does not jump sideways.
  const bar = window.innerWidth - document.documentElement.clientWidth;
  if (bar > 0) body.style.paddingRight = `${bar}px`;
  body.style.overflow = "hidden";
}

function unlockScroll() {
  if (--locks > 0 || !saved) return;
  document.body.style.overflow = saved.overflow;
  document.body.style.paddingRight = saved.paddingRight;
  saved = null;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[inert]"));
}

export interface OverlayLayerOptions {
  /** While false the layer is not on the stack: closed, or animating out. */
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Tab cycles inside. A menu says false and closes on Tab instead. */
  trap?: boolean;
  lockScroll?: boolean;
  /** Focused on open; else the first focusable inside; else the container. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function useOverlayLayer({ active, containerRef, onClose, trap = true, lockScroll: lock = true, initialFocusRef }: OverlayLayerOptions) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!active) return;
    const id = nextId++;
    stack.push(id);
    if (lock) lockScroll();
    const returnTo = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      const first = initialFocusRef?.current ?? focusables(container)[0] ?? container;
      first.focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !trap) return;
      const root = containerRef.current;
      if (!root) return;
      const items = focusables(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !root.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !root.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      if (lock) unlockScroll();
      if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Closes on a pointer down outside every one of `refs` — a menu, a popover. */
export function useOutsidePointer(active: boolean, refs: RefObject<HTMLElement | null>[], onOutside: () => void) {
  const handler = useRef(onOutside);
  handler.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node;
      if (refs.some((r) => r.current?.contains(target))) return;
      handler.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** `end`: beside the trigger at its inline end — the collapsed sidebar's flyout (N3). */
export type Side = "top" | "bottom" | "end";
export type Align = "start" | "center" | "end";

const GAP = 6;
const EDGE = 8;

/**
 * Fixed coordinates for something drawn beside a trigger: below it unless
 * there is no room and more above (or, for `end`, at its inline end, top
 * edges level), aligned by the reading direction (`start`
 * is the right edge in Persian), and kept 8px inside the viewport. Portaled
 * content needs this — inside a scrolling dialog an absolutely placed list is
 * clipped (the kit `Select` says the same).
 */
export function useAnchoredPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  { side = "bottom", align = "start" }: { side?: Side; align?: Align } = {},
): { style: CSSProperties; placedSide: Side } {
  const [state, setState] = useState<{ style: CSSProperties; placedSide: Side }>({ style: { visibility: "hidden" }, placedSide: side });

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const floating = floatingRef.current;
    if (!trigger || !floating) return;
    const t = trigger.getBoundingClientRect();
    const w = floating.offsetWidth;
    const h = floating.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rtl = getComputedStyle(trigger).direction === "rtl";

    if (side === "end") {
      const beside = rtl ? t.left - GAP - w : t.right + GAP;
      const top = Math.max(EDGE, Math.min(t.top, vh - h - EDGE));
      setState({ style: { top, left: Math.max(EDGE, Math.min(beside, vw - w - EDGE)) }, placedSide: "end" });
      return;
    }

    const below = vh - t.bottom;
    const above = t.top;
    const placedSide: Side = side === "bottom" ? (below < h + GAP && above > below ? "top" : "bottom") : above < h + GAP && below > above ? "bottom" : "top";
    const top = placedSide === "bottom" ? t.bottom + GAP : t.top - GAP - h;

    const physical = align === "center" ? "center" : (align === "start") !== rtl ? "left" : "right";
    let left = physical === "left" ? t.left : physical === "right" ? t.right - w : t.left + t.width / 2 - w / 2;
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));

    setState({ style: { top: Math.max(EDGE, top), left }, placedSide });
  }, [triggerRef, floatingRef, side, align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return state;
}

/** A media query, live; false on the server and where `matchMedia` is missing. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** `md` and up — where a sheet comes from the side rather than the bottom (K7). */
export const MD_UP = "(min-width: 768px)";
