"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { CATALOG_KEYS as K } from "../_lib/catalog-form";
import { costFrom, type CostFrom } from "../_lib/cost-form";
import { Button } from "../../_components/kit";
import { useMessage } from "./catalog-ui";

const C = K.cost;

/** What a cost write sends besides its own fields: the start the form chose (none = now). */
export type CostStart = { effectiveFrom?: string };

/**
 * One cost write from the chosen start, then the history read again — a new
 * cost or a take-back (F-1002-j), a variant's or a meter's alike. A refusal is
 * the catalog's (`useMessage`), kept in `error` until the next write.
 */
export function useCostWrite(from: CostFrom, reload: () => Promise<unknown>, now?: Date) {
  const message = useMessage();
  const [error, setError] = useState<string | null>(null);
  const write = async (send: (start: CostStart) => Promise<unknown>) => {
    setError(null);
    const effectiveFrom = costFrom(from, now);
    try {
      await send(effectiveFrom ? { effectiveFrom } : {});
      await reload();
    } catch (e) {
      setError(message(e));
    }
  };
  return { error, write };
}

/** "Remove cost" beside a cost in effect, its hint saying the history is kept (F-1002-j). `id` names the hint. */
export function UnsetCostAction({ id, onUnset }: { id: string; onUnset: () => void }) {
  const { t } = useLocale();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" aria-describedby={`${id}-unset-hint`} onClick={onUnset}>
        {t("common", C.unset)}
      </Button>
      <p id={`${id}-unset-hint`} className="text-xs text-text-secondary">
        {t("common", C.unsetHint)}
      </p>
    </div>
  );
}
