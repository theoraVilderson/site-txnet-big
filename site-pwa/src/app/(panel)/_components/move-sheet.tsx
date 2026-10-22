"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./kit";

/**
 * What every move sheet's form shares — Grants to another group (F-027-ev),
 * configs to another panel (F-311-ae): billing's count for the pick on screen,
 * the start, and the two buttons. The rules of each move stay in its own sheet.
 */

/**
 * Billing's count for `selection`, asked again whenever it changes; `null`
 * while the answer for the pick on screen is not in (a stale answer never
 * reads as the current pick's) and when there is nothing to count.
 */
export function useMoveCount<S, C>(selection: S | null, count: (selection: S) => Promise<C>): { count: C | null; error: unknown } {
  const key = selection === null ? null : JSON.stringify(selection);
  const [answered, setAnswered] = useState<{ key: string; count: C } | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The caller's function may be rebuilt each render; the pick is what asks again.
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  });

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    countRef.current(JSON.parse(key) as S).then(
      (answer) => alive && setAnswered({ key, count: answer }),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [key]);

  return { count: key !== null && answered?.key === key ? answered.count : null, error };
}

/** The start: busy while billing answers, its error kept for the sheet to name, the job handed on. */
export function useMoveStart<J>(onStarted: (job: J) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (start: () => Promise<J>) => {
    setBusy(true);
    setError(null);
    try {
      onStarted(await start());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** The form's start and close. */
export function MoveSheetActions({
  startLabel,
  closeLabel,
  busy,
  disabled,
  onStart,
  onCancel,
}: {
  startLabel: string;
  closeLabel: string;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="primary" size="sm" loading={busy} disabled={disabled} onClick={onStart}>
        {startLabel}
      </Button>
      <Button variant="quiet" size="sm" onClick={onCancel}>
        {closeLabel}
      </Button>
    </div>
  );
}
