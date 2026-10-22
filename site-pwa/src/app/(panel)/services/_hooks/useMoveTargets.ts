"use client";

import { useEffect, useState } from "react";
import { billingApi, type ConfigMoveTargets, type UserConfigRow } from "@/lib/billing-api";

/**
 * Where a Grant's configs may move, and from when (F-410-b), read once per
 * list through its first config: the targets and the wait are the Grant's,
 * so one answer covers every row and the list costs one read, not one per
 * config. A new list — a move retires one row and adds another — reads again,
 * which is how the wait after a move is shown.
 *
 * A failed read offers nothing: the action is hidden rather than guessed,
 * and the list's own read already says when billing cannot be reached.
 */
export function useMoveTargets(rows: UserConfigRow[] | null): ConfigMoveTargets | null {
  const [answer, setAnswer] = useState<{ key: string; targets: ConfigMoveTargets | null } | null>(null);
  const first = rows?.[0]?.id ?? null;
  const key = rows?.map((r) => r.id).join(",") ?? "";

  useEffect(() => {
    if (first === null) return;
    let alive = true;
    billingApi
      .configMoveTargets(first)
      .then((targets) => {
        if (alive) setAnswer({ key, targets });
      })
      .catch(() => {
        if (alive) setAnswer({ key, targets: null });
      });
    return () => {
      alive = false;
    };
  }, [first, key]);

  // An answer for another list — the one before a move — is not this list's: its wait is not known yet.
  return first !== null && answer?.key === key ? answer.targets : null;
}
