"use client";

import { useCallback, useEffect, useRef, useState, type AnimationEvent } from "react";

/**
 * How long after mount to keep looking for a fill. Chrome fills on load, but
 * "load" for an app this size can land well after the first effect, and a
 * password manager extension is later still.
 */
const WATCH_MS = 3000;

/** Chromium/Safari ship the prefixed one, everyone modern ships `:autofill`. */
const AUTOFILL_SELECTORS = [":-webkit-autofill", ":autofill"];

function isAutofilled(el: HTMLInputElement): boolean {
  return AUTOFILL_SELECTORS.some((selector) => {
    // An engine that does not know the selector throws rather than returning
    // false — jsdom included, which is why the tests do not need a shim.
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  });
}

/**
 * Makes browser autofill visible to a controlled input.
 *
 * Two separate things go wrong without it, and both leave a field that looks
 * full while React still holds `""` — floating label down, submit disabled:
 *
 * 1. The browser writes the value straight into the DOM. React's value tracker
 *    never sees it, so `onChange` never runs. Replaying one `input` event is
 *    enough: the tracker is stale, so React reads the DOM value and calls
 *    `onChange` with it.
 * 2. The CSS marker animation (`onAutoFillStart`) fires before hydration has
 *    attached a handler, so `onAnimationStart` never arrives. A one-shot check
 *    on mount misses the other half of the cases — the fill that happens a
 *    beat *after* mount — so this polls a frame at a time until it sees one.
 *
 * The value replay is skipped while the field has focus: a fill the user
 * triggered from the dropdown emits its own event, and the guard keeps the
 * watcher clear of anything being typed or composed.
 *
 * The returned `ref` is a callback ref rather than an object one on purpose:
 * a field behind a tab or a step mounts long after its parent, and the watch
 * has to start when the element arrives, not when the hook is first called.
 *
 * What this hook cannot do is the *preview* state — Chrome paints the text
 * before it will admit to a value, and before hydration there is no JS at all.
 * That half is CSS, in `globals.css`; a floating label needs both.
 */
export function useAutofill(value: string) {
  const [el, setEl] = useState<HTMLInputElement | null>(null);
  const [autofilled, setAutofilled] = useState(false);
  const latest = useRef(value);

  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    if (!el) return;

    const deadline = Date.now() + WATCH_MS;
    let frame = 0;

    const check = () => {
      const filled = isAutofilled(el);
      if (filled) setAutofilled(true);

      const stale = el.value !== latest.current && el !== document.activeElement;
      if (stale) el.dispatchEvent(new Event("input", { bubbles: true }));

      // Once the fill has been seen *and* handed to React there is nothing
      // left to watch for; real edits arrive as real events from here on.
      if ((filled && !stale) || Date.now() > deadline) return;
      frame = requestAnimationFrame(check);
    };

    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [el]);

  const onAnimationStart = useCallback((e: AnimationEvent<HTMLInputElement>) => {
    if (e.animationName === "onAutoFillStart") setAutofilled(true);
    else if (e.animationName === "onAutoFillCancel") setAutofilled(false);
  }, []);

  return { ref: setEl, autofilled, onAnimationStart };
}
