"use client";

import { createContext, useContext } from "react";

/**
 * What a control inside a kit `Field` takes from it (UX-1-c, K4): its id, what
 * describes it, whether it is invalid. Its own file, with no imports, so the
 * kit `Select` can read it without pulling the Field's locale in.
 */
export interface FieldControl {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  /** A control with `maxLength` reports its length, and the Field draws the counter. */
  setCount: (count: { length: number; max: number } | null) => void;
}

export const FieldContext = createContext<FieldControl | null>(null);

/** The surrounding `Field`, or null outside one. */
export function useFieldControl(): FieldControl | null {
  return useContext(FieldContext);
}
