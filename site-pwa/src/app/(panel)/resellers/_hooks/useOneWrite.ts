"use client";

import { useState } from "react";
import { useMessage } from "../_components/resellers-ui";

/**
 * One write at a time, its refusal kept for the form to show, and `onSaved`
 * after it lands — so the caller reads every level again rather than guess
 * what the service resolved (the limits page and a package's sheets, PK-1-f).
 */
export function useOneWrite(onSaved: () => void) {
  const message = useMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await work();
      onSaved();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, failure, run };
}
