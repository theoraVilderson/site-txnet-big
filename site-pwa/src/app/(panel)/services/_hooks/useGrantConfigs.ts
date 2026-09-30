"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { billingApi, type RegenerateTerms, type UserConfigRow } from "@/lib/billing-api";

export interface GrantConfigsState {
  rows: UserConfigRow[] | null;
  /** What a new link costs on this Grant (F-118-r); null without a price. */
  regenerate: RegenerateTerms | null;
  readError: unknown;
  isLoading: boolean;
  /** Read the list again, loudly — after an action, or a retry. */
  reload: () => void;
}

/**
 * One Grant's configs (F-027-ac), read for both halves of its row: "connect"
 * needs their lines, "details" their state and actions. Held by the row, so
 * switching between the two reads nothing twice.
 *
 * Read only while `open`: a user with ten services opens the one they came
 * for. `told` moves when the page heard this Grant's lines were captured
 * (F-111-l, `useGrantsPage`); an open list re-reads quietly on it — no
 * loading state, and a failure keeps what is shown, because the event was a
 * hint (D-15). A closed list absorbs the count: opening reads anyway.
 */
export function useGrantConfigs(grantId: string, open: boolean, told = 0): GrantConfigsState {
  const [rows, setRows] = useState<UserConfigRow[] | null>(null);
  const [regenerate, setRegenerate] = useState<RegenerateTerms | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  // Loading is derived, as in `useGrantsPage`: the read in flight is the one
  // whose key has not landed yet.
  const key = `${grantId}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const isLoading = open && loaded !== key;
  const heard = useRef(told);

  useEffect(() => {
    if (!open) heard.current = told;
    if (told === heard.current) return;
    heard.current = told;
    if (loaded !== key) return; // the loud read in flight answers this too
    let alive = true;
    billingApi
      .grantConfigs(grantId)
      .then((answer) => {
        if (!alive) return;
        setRows(answer.rows);
        setRegenerate(answer.regenerate ?? null);
        setReadError(null);
      })
      .catch(() => {
        // Billing's last answer stays up; the next event or a reopen asks again.
      });
    return () => {
      alive = false;
    };
  }, [open, grantId, told, loaded, key]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    billingApi
      .grantConfigs(grantId)
      .then((answer) => {
        if (!alive) return;
        setRows(answer.rows);
        setRegenerate(answer.regenerate ?? null);
        setReadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setRows(null);
        setReadError(e);
      })
      .finally(() => {
        if (alive) setLoaded(key);
      });
    return () => {
      alive = false;
    };
  }, [open, grantId, key]);

  const reload = useCallback(() => setAsked((n) => n + 1), []);

  return { rows, regenerate, readError, isLoading, reload };
}
