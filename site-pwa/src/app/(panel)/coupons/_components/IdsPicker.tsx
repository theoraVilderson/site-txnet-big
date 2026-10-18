"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { COUPON_KEYS } from "../_lib/coupon-form";
import { idsOf } from "../_lib/discount-rules";
import { Select } from "../../_components/kit/Select";
import { Button, Textarea } from "../../_components/kit";
import type { Choices } from "./ChoicePicker";
import { PickedChips, chipsOf } from "./PickedChips";

const P = COUPON_KEYS.form.picker;

/**
 * Several products or variants, picked by label (UX-3-a) — a coupon's service
 * scope. The form keeps its text of ids, one per line, so validation and the
 * body sent to billing do not change; this only writes that text.
 *
 * The list is `ChoicePicker`'s: a failed read (no `catalog.manage`) leaves the
 * ids box, and "by id" opens it on purpose. A saved id the list does not hold
 * stays as a chip.
 */
export function IdsPicker({ id, value, onChange, choices, invalid = false }: { id: string; value: string; onChange: (text: string) => void; choices: Choices; invalid?: boolean }) {
  const { t } = useLocale();
  const [byHand, setByHand] = useState(false);

  if (choices === null) return <p className="py-2.5 text-xs text-text-secondary">{t("common", P.loading)}</p>;

  if (choices === "failed" || byHand)
    return (
      <div className="flex flex-col gap-1">
        <Textarea id={id} dir="ltr" rows={3} className="font-mono text-xs" aria-invalid={invalid} value={value} onChange={(e) => onChange(e.target.value)} />
        {choices !== "failed" && (
          <Button variant="quiet" size="sm" onClick={() => setByHand(false)} className="self-start text-primary hover:text-primary">
            {t("common", P.fromList)}
          </Button>
        )}
      </div>
    );

  const picked = idsOf(value);
  const rest = choices.filter((c) => !picked.includes(c.value));
  const label = (v: string) => choices.find((c) => c.value === v)?.label;
  return (
    <div className="flex flex-col gap-2">
      <PickedChips items={chipsOf(picked, label)} onRemove={(v) => onChange(picked.filter((x) => x !== v).join("\n"))} />
      {choices.length === 0 ? (
        <p className="py-2.5 text-xs text-text-secondary">{t("common", P.empty)}</p>
      ) : (
        rest.length > 0 && <Select id={id} value="" onChange={(v) => onChange([...picked, v].join("\n"))} invalid={invalid} placeholder={t("common", P.add)} options={rest} />
      )}
      <Button variant="quiet" size="sm" onClick={() => setByHand(true)} className="self-start text-primary hover:text-primary">
        {t("common", P.byId)}
      </Button>
    </div>
  );
}
