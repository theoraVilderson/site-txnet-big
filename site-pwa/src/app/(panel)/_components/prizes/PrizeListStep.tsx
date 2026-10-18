"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { AdminCoupon } from "@/lib/billing-api";
import { useRowKeys } from "../../_hooks/useRowKeys";
import type { PrizeSource } from "../../_hooks/usePrizeSources";
import { moveRow } from "../../_lib/rows";
import { Alert, Button } from "../kit";
import { PrizeFields, PrizeRowHeader, type PrizeCore, type PrizeKeys } from "./PrizeFields";

type Errors<P> = Partial<Record<keyof P, string>>;

export interface PrizeListStepProps<T extends string, P extends PrizeCore<T>> {
  prizes: readonly P[];
  /** Each row's errors, already cut to what this step shows (empty until Next was tried). */
  errors: ReadonlyArray<Errors<P>>;
  /** The whole list's rule (too few, the average over the cap), as a key. */
  overall?: string | null;
  keys: PrizeKeys & { add: string };
  types: readonly T[];
  typeKeys: Record<T, string>;
  templates: PrizeSource<AdminCoupon>;
  ownerTenant: string | null;
  /** The row's id prefix for its variant picker: two lists on one page never share one. */
  idPrefix: string;
  max: number;
  newPrize: () => P;
  onChange: (prizes: P[]) => void;
  /** The row's heading: "Slot 3 · 12%", "Prize 1". */
  rowTitle: (i: number) => ReactNode;
  /** The editor's own fields after the shared ones, in the same grid (weight, cost, winners). */
  extra: (p: P, i: number, e: Errors<P>, patch: (change: Partial<P>) => void) => ReactNode;
  /** A shared field's change, before it is applied: the wheel zeroes an empty slot's cost. */
  adjust?: (change: Partial<PrizeCore<T>>) => Partial<P>;
}

/**
 * The prize step the wheel and lottery wizards share (UX-3-c, UX-3-d): each
 * row's heading with move and remove, `PrizeFields`, then the editor's own
 * fields; an add button up to `max`. It holds no rule: the errors are the
 * host's validator's, and the list is the host's form.
 */
export function PrizeListStep<T extends string, P extends PrizeCore<T>>(props: PrizeListStepProps<T, P>) {
  const { prizes, errors, overall, keys, max, newPrize, onChange, rowTitle, extra, adjust } = props;
  const { t } = useLocale();
  const rowKeys = useRowKeys(prizes);
  const patchAt = (i: number) => (change: Partial<P>) => onChange(prizes.map((p, j) => (j === i ? { ...p, ...change } : p)));

  return (
    <div className="space-y-3">
      {prizes.map((p, i) => {
        const e = errors[i] ?? {};
        const patch = patchAt(i);
        return (
          <div key={rowKeys[i]} className="space-y-3 rounded-xl border border-card-border p-3">
            <PrizeRowHeader
              title={rowTitle(i)}
              index={i}
              count={prizes.length}
              keys={keys}
              onMove={(by) => onChange(moveRow(prizes, i, by))}
              onRemove={() => onChange(prizes.filter((_, j) => j !== i))}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <PrizeFields
                prize={p}
                errors={e}
                keys={keys}
                types={props.types}
                typeKeys={props.typeKeys}
                templates={props.templates}
                variantFieldId={`${props.idPrefix}-variant-${i}`}
                ownerTenant={props.ownerTenant}
                onPatch={(change) => patch(adjust ? adjust(change) : (change as Partial<P>))}
              />
              {extra(p, i, e, patch)}
            </div>
          </div>
        );
      })}
      {prizes.length < max && (
        <Button variant="quiet" size="sm" onClick={() => onChange([...prizes, newPrize()])} icon={<Plus size={12} aria-hidden />}>
          {t("common", keys.add)}
        </Button>
      )}
      {overall && <Alert tone="error">{t("common", overall)}</Alert>}
    </div>
  );
}
