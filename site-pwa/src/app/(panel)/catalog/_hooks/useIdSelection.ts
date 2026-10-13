"use client";

import { useState } from "react";
import { stillSelected } from "../_lib/catalog-form";

/**
 * The rows a person ticked on one catalog tab (F-026-i, F-026-k). Read through
 * the rows still listed, so one a removal or another tab took away is never
 * acted on — derived at render, not pruned after every read (C-30).
 */
export function useIdSelection(listed: readonly { id: string }[]) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const selected = stillSelected(picked, listed);
  const toggle = (id: string) =>
    setPicked((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pick = (ids: readonly string[]) => setPicked(new Set(ids));
  return { selected, toggle, pick, clear: () => pick([]) };
}

export type IdSelection = ReturnType<typeof useIdSelection>;
