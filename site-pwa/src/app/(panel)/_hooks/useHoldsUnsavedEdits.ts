"use client";

import { createContext, useContext, useEffect } from "react";

/** Takes one hold on the page and returns its release. */
export type HoldUnsavedEdits = () => () => void;

/**
 * The panel template's count of forms with unsaved edits (RT-1-m,
 * `realtime/contract.live-events.md`). Null outside the template — a test or a
 * screen rendered alone — where holding is a no-op.
 */
export const UnsavedEditsContext = createContext<HoldUnsavedEdits | null>(null);

/**
 * While `dirty`, the page is not remounted under the user by a live re-read
 * that would drop what they typed (a currency change, RT-1-m): the template
 * shows a reload banner instead. `useUnsavedGuard` and the kit `Wizard` call
 * it, so a form that already asks before leaving holds without a second line.
 */
export function useHoldsUnsavedEdits(dirty: boolean): void {
  const hold = useContext(UnsavedEditsContext);
  useEffect(() => {
    if (!dirty || !hold) return;
    return hold();
  }, [dirty, hold]);
}
